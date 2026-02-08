import { useState, useEffect, useRef } from "react";
import {
  Radio,
  Zap,
  ZapOff,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Key,
  Copy,
  Check,
} from "lucide-react";
import { useWebNfc } from "@uverify/asymmetric-nfc";

const App = () => {
  const [message, setMessage] = useState("Hello World");
  const [status, setStatus] = useState<
    "idle" | "writing" | "computing" | "done"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [signature, setSignature] = useState("");
  const [error, setError] = useState("");
  const [statusText, setStatusText] = useState("Ready to sign");
  const [stepsRemaining, setStepsRemaining] = useState<number | null>(null);
  const [stepsTotal, setStepsTotal] = useState<number | null>(null);
  const [lastReadTime, setLastReadTime] = useState<number>(0);
  const [isScanning, setIsScanning] = useState(false);
  const [tagInRange, setTagInRange] = useState(true);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [publicKey, setPublicKey] = useState("");
  const [chipId, setChipId] = useState("");
  const [isGettingDeviceInfo, setIsGettingDeviceInfo] = useState(false);
  const [copiedPubkey, setCopiedPubkey] = useState(false);
  const [copiedChipId, setCopiedChipId] = useState(false);
  const [copiedSignature, setCopiedSignature] = useState(false);

  const powerCycleIntervalRef = useRef<any>(null);
  const statusRef = useRef<"idle" | "writing" | "computing" | "done">("idle");
  const lastStepsRef = useRef<number | null>(null);
  const stuckCountRef = useRef<number>(0);

  // NEW: keep latest isGettingDeviceInfo in a ref to avoid stale closure
  const isGettingDeviceInfoRef = useRef<boolean>(isGettingDeviceInfo);
  useEffect(() => {
    isGettingDeviceInfoRef.current = isGettingDeviceInfo;
  }, [isGettingDeviceInfo]);

  // NEW: failsafe timeout for single-read
  const singleReadTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const addDebugLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLogs((prev) => [...prev.slice(-15), `[${timestamp}] ${msg}`]);
  };

  const { isSupported, startScan, stopScan, writeText, startSingleRead } =
    useWebNfc({
      onReading: (tagId, payload: any) => {
        addDebugLog(`Reading [${tagId}]: ${JSON.stringify(payload)}`);
        setLastReadTime(Date.now());
        setTagInRange(true);
        if (!payload) return;

        const isHex = (s: any, len: number) =>
          typeof s === "string" && new RegExp(`^[0-9a-fA-F]{${len}}$`).test(s);

        // Single-read device info mode
        if (isGettingDeviceInfoRef.current) {
          let gotSomething = false;

          // Accept parsed PH_IDLE and explicit key fields
          const pk =
            (payload.state === "PH_IDLE" ? payload.pubkey : undefined) ||
            payload.publicKey ||
            payload.pubkey;

          const cid: string | undefined = payload.chipId || payload.uid;

          if (isHex(pk, 64)) {
            addDebugLog(
              `Public Key received (64-hex): ${pk.substring(0, 16)}...`
            );
            setPublicKey(pk);
            gotSomething = true;
          }

          if (typeof cid === "string" && cid.length) {
            addDebugLog(`Chip ID received: ${cid.substring(0, 16)}...`);
            setChipId(cid);
            gotSomething = true;
          }

          // Clear failsafe timeout if set
          if (singleReadTimeoutRef.current) {
            clearTimeout(singleReadTimeoutRef.current);
            singleReadTimeoutRef.current = null;
          }

          if (gotSomething) {
            setIsGettingDeviceInfo(false);
            stopScan();
            setIsScanning(false);
            return;
          }

          stopScan();
          setIsScanning(false);
          setIsGettingDeviceInfo(false);
          setError(
            "Device info payload not recognized (expecting 64-hex pubkey)"
          );
          return;
        }

        // Signing state machine (already parsed by the hook)
        switch (payload.state) {
          case "PH_INIT_K":
            addDebugLog("State: PH_INIT_K");
            setStatus("computing");
            setStatusText("Initializing (K)...");
            setProgress(
              typeof payload.progress === "number" ? payload.progress : 10
            );
            lastStepsRef.current = null;
            stuckCountRef.current = 0;
            break;

          case "PH_INIT_R":
            addDebugLog("State: PH_INIT_R");
            setStatus("computing");
            setStatusText("Initializing (R)...");
            setProgress(
              typeof payload.progress === "number" ? payload.progress : 10
            );
            lastStepsRef.current = null;
            stuckCountRef.current = 0;
            break;

          case "PH_R_WORK": {
            setStatus("computing");
            const steps =
              typeof payload.stepsRemaining === "number"
                ? payload.stepsRemaining
                : undefined;

            if (typeof steps === "number") {
              addDebugLog(`State: PH_R_WORK, stepsRemaining: ${steps}`);

              if (lastStepsRef.current === steps) {
                stuckCountRef.current++;
                addDebugLog(
                  `⚠️ Progress stuck (count: ${stuckCountRef.current})`
                );
              } else {
                stuckCountRef.current = 0;
              }
              lastStepsRef.current = steps;

              setStepsRemaining(steps);
              setStepsTotal(
                typeof payload.stepsTotal === "number"
                  ? payload.stepsTotal
                  : null
              );

              if (typeof payload.progress === "number") {
                setProgress(payload.progress);
                setStatusText(
                  `Computing R phase... ${payload.progress}% (${steps} steps remaining)`
                );
              } else {
                setProgress((prev: number) => Math.max(prev ?? 0, 10));
                setStatusText(
                  `Computing R phase... (${steps} steps remaining)`
                );
              }
            } else {
              addDebugLog("State: PH_R_WORK (no steps info)");
              if (typeof payload.progress === "number") {
                setProgress(payload.progress);
              } else {
                setProgress((prev: number) => Math.max(prev ?? 0, 10));
              }
              setStatusText("Computing R phase...");
            }
            break;
          }

          case "PH_R_DONE":
            addDebugLog("State: PH_R_DONE");
            setStatus("computing");
            // Hook maps the last 5% to this phase; use provided progress or default to 97%
            setProgress((prev: number) =>
              Math.max(
                prev ?? 0,
                typeof payload.progress === "number" ? payload.progress : 97
              )
            );
            setStatusText("R phase complete. Finalizing signature...");
            break;

          case "PH_DONE":
            addDebugLog("State: PH_DONE");
            setStatus("done");
            setProgress(100);
            setStatusText("Signature complete!");
            if (payload.signature && isHex(payload.signature, 128)) {
              addDebugLog(
                `Signature: ${payload.signature.substring(0, 16)}...`
              );
              setSignature(payload.signature);
            }
            setTimeout(() => stopPowerCycling(), 1000);
            break;

          case "PH_IDLE": {
            const pk = payload.pubkey;
            if (isHex(pk, 64)) {
              addDebugLog(
                `Idle public key broadcast: ${pk.substring(0, 16)}...`
              );
              setPublicKey(pk);
            } else {
              addDebugLog("State: PH_IDLE");
            }
            setStatus("idle");
            setStatusText("Device idle");
            break;
          }

          case "BUSY":
            addDebugLog("State: BUSY");
            setStatus("computing");
            setStatusText("Device busy. Keep the tag in place...");
            break;

          case "ERROR":
            addDebugLog(`Error: ${payload.error}`);
            setError(payload.error || "Unknown error from device");
            setStatus("idle");
            stopPowerCycling();
            break;

          default:
            addDebugLog(`Unrecognized state: ${JSON.stringify(payload.state)}`);
            break;
        }
      },
      onError: (err) => {
        addDebugLog(`NFC Error: ${err.message}`);
        setError(`NFC Error: ${err.message}`);
      },
    });

  const [isFieldActive, setIsFieldActive] = useState(false);

  useEffect(() => {
    if (!isScanning) {
      setIsFieldActive(false);
      return;
    }
    setIsFieldActive(true);
    const checkActivity = setInterval(() => {
      const timeSinceLastRead = Date.now() - lastReadTime;
      setTagInRange(timeSinceLastRead < 5000);
    }, 1000);
    return () => clearInterval(checkActivity);
  }, [isScanning, lastReadTime]);

  // Single-read device info flow
  const handleGetDeviceInfo = async () => {
    try {
      setError("");
      setIsGettingDeviceInfo(true);
      isGettingDeviceInfoRef.current = true; // keep ref in sync immediately
      setPublicKey("");
      setChipId("");

      // Clear any previous failsafe
      if (singleReadTimeoutRef.current) {
        clearTimeout(singleReadTimeoutRef.current);
        singleReadTimeoutRef.current = null;
      }

      addDebugLog("Writing 'pubkey' command to tag...");
      await writeText("pubkey");
      addDebugLog("Command written. Starting single-read scan...");

      await startSingleRead(3000); // times out automatically if nothing read in 3s
      setIsScanning(true);
      setLastReadTime(Date.now());

      // Failsafe to stop spinner if nothing arrives
      singleReadTimeoutRef.current = window.setTimeout(() => {
        if (isGettingDeviceInfoRef.current) {
          addDebugLog("Device info read timed out");
          setIsGettingDeviceInfo(false);
          setIsScanning(false);
          try {
            stopScan();
          } catch {}
          setError("Timed out reading device info");
        }
      }, 3200) as unknown as number;
    } catch (err) {
      const error = err as Error;
      addDebugLog(`Error getting device info: ${error.message}`);
      setError(`Failed: ${error.message}`);
      setIsGettingDeviceInfo(false);
      isGettingDeviceInfoRef.current = false;
      try {
        stopScan();
      } catch {}
      setIsScanning(false);
    }
  };

  const copyToClipboard = async (
    text: string,
    type: "pubkey" | "signature" | "chipId"
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "pubkey") {
        setCopiedPubkey(true);
        setTimeout(() => setCopiedPubkey(false), 2000);
      } else if (type === "chipId") {
        setCopiedChipId(true);
        setTimeout(() => setCopiedChipId(false), 2000);
      } else {
        setCopiedSignature(true);
        setTimeout(() => setCopiedSignature(false), 2000);
      }
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleSign = async () => {
    if (!message.trim()) return;
    try {
      setError("");
      setStatus("writing");
      setStatusText("Please hold your phone near the NFC tag...");
      setProgress(0);
      setSignature("");
      setStepsRemaining(null);
      setStepsTotal(null);
      setDebugLogs([]);
      lastStepsRef.current = null;
      stuckCountRef.current = 0;
      addDebugLog("Writing message to tag...");
      await writeText(message);
      addDebugLog("Message written successfully");
      setStatusText("Message written! Starting power cycles...");
      setStatus("computing");
      setIsScanning(true);
      setLastReadTime(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 100));
      startPowerCycling();
    } catch (err) {
      const error = err as Error;
      addDebugLog(`Error: ${error.message}`);
      setError(`Failed: ${error.message}`);
      setStatus("idle");
      setStatusText("Ready to sign");
    }
  };

  const startPowerCycling = () => {
    let cycleCount = 0;
    const maxCycles = 100;
    let shouldContinue = true;
    addDebugLog("Initializing power cycling...");

    const doCycle = async () => {
      if (cycleCount >= maxCycles) {
        addDebugLog("Max cycles reached, stopping");
        stopPowerCycling();
        setError("Computation timeout");
        return false;
      }
      if (!shouldContinue) {
        addDebugLog("Computation complete, stopping cycles");
        return false;
      }
      cycleCount++;
      addDebugLog(`Cycle ${cycleCount}: Powering chip for 20s...`);
      setIsFieldActive(true);
      try {
        await startScan({
          pollMs: 300,
          deepResetEveryMs: 999999,
          deepResetPauseMs: 0,
          staleAfterMs: 999999,
        });
        addDebugLog("Scan started, waiting 20s...");
        await new Promise((resolve) => setTimeout(resolve, 20000));
        addDebugLog("Stopping scan to read...");
        stopScan();
        setIsFieldActive(false);
        await new Promise((resolve) => setTimeout(resolve, 500));
        addDebugLog("Reading status...");
        await startScan({
          pollMs: 300,
          deepResetEveryMs: 999999,
          deepResetPauseMs: 0,
          staleAfterMs: 999999,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        addDebugLog("Read complete, stopping scan");
        stopScan();
        setIsFieldActive(false);
        await new Promise((resolve) => setTimeout(resolve, 500));
        return true;
      } catch (err) {
        const error = err as Error;
        addDebugLog(`Cycle error: ${error.message}`);
        return false;
      }
    };

    const runCycles = async () => {
      if (statusRef.current !== "computing") {
        addDebugLog("Status changed, stopping cycles");
        stopPowerCycling();
        return;
      }
      const continueNext = await doCycle();
      if (continueNext && shouldContinue && statusRef.current === "computing") {
        addDebugLog("Scheduling next cycle...");
        powerCycleIntervalRef.current = window.setTimeout(
          () => runCycles(),
          100
        );
      } else {
        addDebugLog("Stopping power cycles");
        stopPowerCycling();
      }
    };

    powerCycleIntervalRef.current = {
      stop: () => {
        shouldContinue = false;
        addDebugLog("Stop requested");
      },
    } as any;
    addDebugLog("Starting first cycle...");
    runCycles();
  };

  const stopPowerCycling = () => {
    if (powerCycleIntervalRef.current) {
      if (
        typeof powerCycleIntervalRef.current === "object" &&
        "stop" in powerCycleIntervalRef.current
      ) {
        (powerCycleIntervalRef.current as any).stop();
      } else {
        clearTimeout(powerCycleIntervalRef.current as number);
      }
      powerCycleIntervalRef.current = null;
    }
    stopScan();
    setIsScanning(false);
    setIsFieldActive(false);
  };

  const cancelOperation = () => {
    stopPowerCycling();
    setStatus("idle");
    setStatusText("Ready to sign");
    setProgress(0);
    setError("");
    setIsFieldActive(false);
  };

  useEffect(() => {
    return () => {
      stopPowerCycling();
      if (singleReadTimeoutRef.current) {
        clearTimeout(singleReadTimeoutRef.current);
        singleReadTimeoutRef.current = null;
      }
    };
  }, []);

  if (!isSupported) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center p-4">
        <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-6 max-w-md">
          <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">
            NFC Not Supported
          </h2>
          <p className="text-gray-300">
            Web NFC is not supported on this device or browser. Please use a
            compatible Android device with Chrome.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl shadow-2xl border border-slate-700 overflow-hidden">
          <div className="bg-gradient-to-r from-blue-600 to-purple-600 p-6">
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <Radio className="w-8 h-8" />
              NFC EdDSA Signer
            </h1>
            <p className="text-blue-100 mt-2">
              Sign messages using NFC-powered EdDSA on LPC8N04
            </p>
          </div>

          <div className="p-6 space-y-6">
            {/* Device Info */}
            <div className="bg-slate-900/30 rounded-lg p-4 border border-slate-700">
              <div className="flex items-center gap-2 mb-3">
                <Key className="w-5 h-5 text-purple-400" />
                <h2 className="text-lg font-semibold text-white">
                  Device Information
                </h2>
              </div>
              <button
                onClick={handleGetDeviceInfo}
                disabled={
                  isGettingDeviceInfo ||
                  status === "computing" ||
                  status === "writing"
                }
                className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-lg transition-all duration-200 flex items-center justify-center gap-2 mb-3"
              >
                {isGettingDeviceInfo ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Reading Device Info...
                  </>
                ) : (
                  <>
                    <Key className="w-4 h-4" />
                    Get Device Info
                  </>
                )}
              </button>

              {(chipId || publicKey) && (
                <div className="space-y-3">
                  {chipId && (
                    <div className="relative">
                      <label className="block text-xs text-gray-400 mb-1">
                        Chip ID
                      </label>
                      <input
                        type="text"
                        value={chipId}
                        readOnly
                        className="w-full px-4 py-2 pr-10 bg-slate-900 border border-purple-500/50 rounded-lg text-purple-300 text-sm font-mono"
                      />
                      <button
                        onClick={() => copyToClipboard(chipId, "chipId")}
                        className="absolute right-2 top-8 -translate-y-1/2 p-1.5 hover:bg-slate-700 rounded transition-colors"
                        title="Copy to clipboard"
                      >
                        {copiedChipId ? (
                          <Check className="w-4 h-4 text-green-400" />
                        ) : (
                          <Copy className="w-4 h-4 text-gray-400" />
                        )}
                      </button>
                    </div>
                  )}

                  {publicKey && (
                    <div className="relative">
                      <label className="block text-xs text-gray-400 mb-1">
                        Public Key
                      </label>
                      <input
                        type="text"
                        value={publicKey}
                        readOnly
                        className="w-full px-4 py-2 pr-10 bg-slate-900 border border-purple-500/50 rounded-lg text-purple-300 text-sm font-mono"
                      />
                      <button
                        onClick={() => copyToClipboard(publicKey, "pubkey")}
                        className="absolute right-2 top-8 -translate-y-1/2 p-1.5 hover:bg-slate-700 rounded transition-colors"
                        title="Copy to clipboard"
                      >
                        {copiedPubkey ? (
                          <Check className="w-4 h-4 text-green-400" />
                        ) : (
                          <Copy className="w-4 h-4 text-gray-400" />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Message */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Message to Sign
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={status === "computing" || status === "writing"}
                className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed resize-none"
                rows={4}
                placeholder="Enter message to sign..."
              />
            </div>

            {/* Field status */}
            {status !== "idle" && (
              <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-300">
                    Field Status
                  </span>
                  <div className="flex items-center gap-2">
                    {isFieldActive ? (
                      <>
                        <Zap className="w-5 h-5 text-yellow-400 animate-pulse" />
                        <span className="text-sm font-semibold text-yellow-400">
                          Active
                        </span>
                      </>
                    ) : (
                      <>
                        <ZapOff className="w-5 h-5 text-gray-500" />
                        <span className="text-sm font-semibold text-gray-500">
                          Inactive
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {!tagInRange && status === "computing" && (
                  <div className="flex items-center gap-2 text-orange-400 text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>Hold phone near tag to power the chip</span>
                  </div>
                )}
              </div>
            )}

            {/* Progress */}
            {status === "computing" && (
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-300">
                    Computation Progress
                    {stepsRemaining !== null && stepsTotal !== null && (
                      <span className="text-gray-500 ml-2">
                        ({stepsRemaining}/{stepsTotal} steps)
                      </span>
                    )}
                  </span>
                  <span className="text-sm font-bold text-blue-400">
                    {progress}%
                  </span>
                </div>
                <div className="w-full bg-slate-900 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-blue-500 to-purple-500 h-full transition-all duration-500 ease-out"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Status text */}
            <div className="flex items-center gap-3 text-gray-300">
              {status === "computing" && (
                <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
              )}
              {status === "done" && (
                <CheckCircle2 className="w-5 h-5 text-green-400" />
              )}
              <span>{statusText}</span>
            </div>

            {/* Error */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <span className="text-red-300 text-sm">{error}</span>
              </div>
            )}

            {/* Signature */}
            {signature && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Signature (Hex)
                </label>
                <div className="relative bg-slate-900 border border-green-500/50 rounded-lg p-4">
                  <code className="text-green-400 text-xs break-all font-mono pr-8">
                    {signature}
                  </code>
                  <button
                    onClick={() => copyToClipboard(signature, "signature")}
                    className="absolute right-3 top-3 p-1.5 hover:bg-slate-700 rounded transition-colors"
                    title="Copy to clipboard"
                  >
                    {copiedSignature ? (
                      <Check className="w-4 h-4 text-green-400" />
                    ) : (
                      <Copy className="w-4 h-4 text-gray-400" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              {status === "idle" || status === "done" ? (
                <button
                  onClick={handleSign}
                  disabled={!message.trim()}
                  className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-600 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200 flex items-center justify-center gap-2 shadow-lg"
                >
                  <Radio className="w-5 h-5" />
                  Sign Message
                </button>
              ) : (
                <button
                  onClick={cancelOperation}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-6 rounded-lg transition-all duration-200"
                >
                  Cancel
                </button>
              )}
            </div>

            {/* Debug logs */}
            {debugLogs.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-300">
                    Debug Logs
                  </label>
                  <button
                    onClick={() => setDebugLogs([])}
                    className="text-xs text-gray-500 hover:text-gray-300"
                  >
                    Clear
                  </button>
                </div>
                <div className="bg-slate-900 border border-slate-600 rounded-lg p-3 max-h-48 overflow-y-auto">
                  {debugLogs.map((log, idx) => (
                    <div
                      key={idx}
                      className="text-xs text-gray-400 font-mono mb-1"
                    >
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 text-center text-gray-400 text-sm">
          <p>Hold your phone steady near the NFC tag during computation</p>
          <p className="mt-1">The chip is powered by your phone's NFC field</p>
        </div>
      </div>
    </div>
  );
};

export default App;
