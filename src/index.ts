import { useRef, useEffect } from "react";

type OnReading = (tagId: string | undefined, payload: any) => void;
type OnError = (err: Error) => void;

type StartOpts = {
  pollMs?: number;
  deepResetEveryMs?: number;
  deepResetPauseMs?: number;
  staleAfterMs?: number;
};

type EdSignStatus =
  | { state: "ERROR"; error: string }
  | { state: "PH_INIT_K"; progress?: number }
  | { state: "PH_INIT_R"; progress?: number }
  | { state: "PH_R_WORK"; stepsRemaining?: number; stepsTotal?: number } // added stepsTotal
  | { state: "PH_R_DONE"; progress?: number }
  | { state: "PH_DONE"; progress: number; signature?: string }
  | { state: "PH_IDLE"; pubkey: string }
  | { state: "BUSY" }
  | null;

export function useWebNfc(
  opts: { onReading?: OnReading; onError?: OnError } = {}
) {
  const { onReading, onError } = opts;

  // Keep latest callbacks in refs to avoid stale closures
  const onReadingRef = useRef<OnReading | undefined>(onReading);
  const onErrorRef = useRef<OnError | undefined>(onError);
  useEffect(() => {
    onReadingRef.current = onReading;
    onErrorRef.current = onError;
  }, [onReading, onError]);

  const readerRef = useRef<any | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const scanIntervalRef = useRef<number | undefined>(undefined);
  const restartingRef = useRef<boolean>(false);

  const pollingMsRef = useRef<number>(1000);
  const deepEveryRef = useRef<number>(10000);
  const deepPauseRef = useRef<number>(1800);
  const staleAfterRef = useRef<number>(5000);

  const lastHashRef = useRef<string>("");
  const lastPayloadRef = useRef<string>("");
  const lastUpdateTsRef = useRef<number>(0);
  const lastDeepResetTsRef = useRef<number>(0);

  // Previously used to derive a dynamic baseline. Kept for compatibility but no longer used.
  const rBaselineRef = useRef<number | null>(null);

  // control rescan after reading for single-shot reads
  const suppressRescanRef = useRef<boolean>(false);

  const isSupported =
    typeof window !== "undefined" && "NDEFReader" in (window as any);

  // ---- Progress mapping constants (CHANGED) ----
  const TOTAL_STEPS = 255;
  const INIT_PROGRESS = 10; // 10% for initialization
  const R_DONE_PROGRESS = 95; // up to 95% when stepsRemaining hits 0

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  function clamp01to100(n: number) {
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // Fixed mapping: remaining 255→0 maps to 10%→95% (CHANGED)
  function progressFromRemaining(rem: number): {
    progress: number;
    stepsTotal: number;
  } {
    const clamped = Math.max(0, Math.min(TOTAL_STEPS, Math.round(rem)));
    const ratio = (TOTAL_STEPS - clamped) / TOTAL_STEPS; // 0..1
    const pct = INIT_PROGRESS + ratio * (R_DONE_PROGRESS - INIT_PROGRESS);
    return { progress: clamp01to100(pct), stepsTotal: TOTAL_STEPS };
  }

  function parseEdSignTextStatus(text: string): EdSignStatus {
    const t = text.trim();
    console.log("[NFC Hook] Parsing text:", JSON.stringify(t));

    // Errors
    if (/err(or)?/i.test(t)) return { state: "ERROR", error: t };

    // Explicit init phases (CHANGED: set progress to INIT_PROGRESS)
    if (/\bPH_INIT_K\b/i.test(t))
      return { state: "PH_INIT_K", progress: INIT_PROGRESS };
    if (/\bPH_INIT_R\b/i.test(t))
      return { state: "PH_INIT_R", progress: INIT_PROGRESS };

    // R work: "R:i=<n>" (canonical in new firmware)
    const r = t.match(/R\s*:?\s*i\s*=\s*(\d+)/i);
    if (r) {
      const remaining = Number(r[1]);
      console.log("[NFC Hook] Parsed R phase, remaining:", remaining);
      return { state: "PH_R_WORK", stepsRemaining: remaining };
    }

    // R work (fallback): lines starting with "R" and containing a number
    if (/^R\b/i.test(t)) {
      const num = t.match(/(\d+)/);
      if (num) {
        const remaining = Number(num[1]);
        console.log(
          "[NFC Hook] Parsed R phase (fallback), remaining:",
          remaining
        );
        return { state: "PH_R_WORK", stepsRemaining: remaining };
      }
      return { state: "PH_R_WORK" };
    }

    // R done: "R:done" (new firmware)
    if (/\bR\s*:?\s*done\b/i.test(t)) {
      return { state: "PH_R_DONE" };
    }

    // Final 128-hex signature (PH_DONE in new firmware)
    if (t.length === 128 && /^[0-9A-F]+$/i.test(t)) {
      return { state: "PH_DONE", signature: t, progress: 100 };
    }

    // Idle/public key: 64-hex (emitted when no RAM state or PH_IDLE)
    if (t.length === 64 && /^[0-9A-F]+$/i.test(t)) {
      return { state: "PH_IDLE", pubkey: t };
    }

    // Busy (fallback from firmware "else" branch)
    if (/^\s*busy\s*$/i.test(t)) {
      return { state: "BUSY" };
    }

    // Legacy fallbacks (not used by new firmware but kept for resilience)
    if (/sig(nature)?/i.test(t)) {
      const hex = t.match(/\b[0-9a-f]{64,}\b/i)?.[0];
      if (hex && hex.length === 128)
        return { state: "PH_DONE", signature: hex, progress: 100 };
      return { state: "PH_DONE", progress: 100 };
    }
    if (/\b(done|ok|success)\b/i.test(t)) {
      return { state: "PH_DONE", progress: 100 };
    }

    // No match
    return null;
  }

  function emitIfChanged(tagId: string | undefined, payload: any) {
    const sig = JSON.stringify(payload);
    if (sig !== lastPayloadRef.current) {
      lastPayloadRef.current = sig;
      lastUpdateTsRef.current = Date.now();
      onReadingRef.current?.(tagId, payload);
    }
  }

  function safeDecode(dec: TextDecoder, data: ArrayBuffer | undefined) {
    try {
      if (!data) return "";
      return dec.decode(data);
    } catch {
      return "";
    }
  }

  function tryParseFromEvent(event: any): any | null {
    const dec = new TextDecoder();

    const msgSig = JSON.stringify(
      event.message.records.map((r: any) => ({
        t: r.recordType,
        m: r.mediaType,
        id: r.id,
        len: r.data?.byteLength ?? 0,
      }))
    );
    if (lastHashRef.current !== msgSig) {
      lastHashRef.current = msgSig;
    }

    // 1) Try JSON records
    for (const record of event.message.records) {
      if (
        record.mediaType === "application/vnd.edsign+json" ||
        record.mediaType === "application/json"
      ) {
        const text = safeDecode(dec, record.data);
        if (
          text &&
          (text.trim().startsWith("{") || text.trim().startsWith("["))
        ) {
          try {
            return JSON.parse(text);
          } catch {}
        }
      }
    }

    // 2) Try text record containing JSON
    for (const record of event.message.records) {
      if (record.recordType === "text") {
        const text = safeDecode(dec, record.data);
        if (
          text &&
          (text.trim().startsWith("{") || text.trim().startsWith("["))
        ) {
          try {
            return JSON.parse(text);
          } catch {}
        }
      }
    }

    // 3) Try to parse signing status from text
    for (const record of event.message.records) {
      if (record.recordType === "text") {
        const text = safeDecode(dec, record.data) ?? "";
        const status = parseEdSignTextStatus(text) as EdSignStatus | null;
        if (status) {
          // Inject progress for init phases if not set (CHANGED)
          if (
            (status.state === "PH_INIT_K" || status.state === "PH_INIT_R") &&
            typeof (status as any).progress !== "number"
          ) {
            (status as any).progress = INIT_PROGRESS;
          }

          // Map stepsRemaining to progress 10→95 and set stepsTotal=255 (CHANGED)
          if (typeof (status as any).stepsRemaining === "number") {
            const { progress, stepsTotal } = progressFromRemaining(
              (status as any).stepsRemaining
            );
            (status as any).progress = progress;
            (status as any).stepsTotal = stepsTotal;
          }

          // Nudge PH_R_DONE into the last 5% window (e.g., 97%) (CHANGED)
          if (
            status.state === "PH_R_DONE" &&
            typeof (status as any).progress !== "number"
          ) {
            (status as any).progress = Math.max(R_DONE_PROGRESS, 97);
            (status as any).stepsTotal = TOTAL_STEPS;
          }

          // Ensure PH_DONE is 100%
          if (status.state === "PH_DONE") (status as any).progress = 100;

          return status;
        }
      }
    }

    // 4) As a last resort, synthesize a plain payload with raw text lines
    const texts: string[] = [];
    for (const record of event.message.records) {
      if (record.recordType === "text") {
        const text = safeDecode(dec, record.data) ?? "";
        if (text) texts.push(text.trim());
      }
    }

    if (texts.length) {
      const rawText = texts.join("\n").trim();

      // If it's exactly a 64-hex string, interpret as public key
      if (/^[0-9a-fA-F]{64}$/.test(rawText)) {
        return { publicKey: rawText };
      }

      // Heuristics for labeled text
      const pubkeyMatch = rawText.match(
        /(pubkey|public[_\s]?key)\s*[:=]\s*([0-9a-fA-F]+)/i
      );
      const uidMatch = rawText.match(
        /\b(uid|chip[_\s]?id)\s*[:=]\s*([0-9a-fA-F]+)/i
      );
      const payload: any = { rawText };
      if (pubkeyMatch) payload.publicKey = pubkeyMatch[2];
      if (uidMatch) payload.chipId = uidMatch[2];
      return payload;
    }

    return null;
  }

  async function doScan() {
    if (!isSupported) throw new Error("Web NFC not supported in this browser");

    const reader = readerRef.current ?? new (window as any).NDEFReader();
    readerRef.current = reader;

    if (!(reader as any)._listenersAttached) {
      (reader as any)._listenersAttached = true;

      reader.addEventListener("reading", (event: any) => {
        try {
          console.log("[NFC Hook] Reading event received");
          const tagId = event.serialNumber as string | undefined;
          const parsed = tryParseFromEvent(event);
          console.log("[NFC Hook] Parsed result:", parsed);
          if (parsed) emitIfChanged(tagId, parsed);
          else console.log("[NFC Hook] No parsed result from event");

          // only schedule rescan if not in single-shot mode
          if (!suppressRescanRef.current) {
            window.setTimeout(() => void rescanNow("after-reading"), 150);
          }
        } catch (e) {
          console.error("[NFC Hook] Error in reading event:", e);
          onErrorRef.current?.(e as Error);
        }
      });

      reader.addEventListener("readingerror", () => {
        // Non-NDEF or tag moved - not fatal
      });
    }

    controllerRef.current?.abort();
    await sleep(50);
    controllerRef.current = new AbortController();
    try {
      await reader.scan({ signal: controllerRef.current.signal });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      if (e?.name === "NotAllowedError") throw e;
    }
  }

  async function rescanNow(_reason = "") {
    console.log(`[NFC Hook] rescanNow triggered. Reason: ${_reason}`);
    if (restartingRef.current) return;
    restartingRef.current = true;
    try {
      await doScan();
    } finally {
      restartingRef.current = false;
    }
  }

  async function deepReset() {
    console.log("[NFC Hook] Performing DEEP RESET.");
    controllerRef.current?.abort();
    await sleep(deepPauseRef.current);
    await doScan();
    lastDeepResetTsRef.current = Date.now();
  }

  async function startScan(opts?: StartOpts) {
    pollingMsRef.current = Math.max(250, opts?.pollMs ?? 1000);
    deepEveryRef.current = Math.max(3000, opts?.deepResetEveryMs ?? 10000);
    deepPauseRef.current = Math.max(500, opts?.deepResetPauseMs ?? 1800);
    staleAfterRef.current = Math.max(2000, opts?.staleAfterMs ?? 5000);

    rBaselineRef.current = null;
    lastPayloadRef.current = "";
    lastHashRef.current = "";

    // Ensure continuous mode
    suppressRescanRef.current = false;

    await doScan();
    lastDeepResetTsRef.current = Date.now();
    lastUpdateTsRef.current = Date.now();

    stopPolling();
    scanIntervalRef.current = window.setInterval(async () => {
      const now = Date.now();
      const dueDeep = now - lastDeepResetTsRef.current >= deepEveryRef.current;
      const stale = now - lastUpdateTsRef.current >= staleAfterRef.current;

      if (dueDeep || stale) {
        await deepReset();
      } else {
        await rescanNow("interval");
      }
    }, pollingMsRef.current) as unknown as number;
  }

  // single-shot read that stops after first reading event or timeout
  async function startSingleRead(timeoutMs = 3000) {
    // Disable auto rescan & interval polling
    suppressRescanRef.current = true;
    stopPolling();

    rBaselineRef.current = null;
    lastPayloadRef.current = "";
    lastHashRef.current = "";

    await doScan();

    // Timeout to abort if nothing is read
    const localController = controllerRef.current;
    const to = window.setTimeout(() => {
      if (controllerRef.current === localController) {
        console.log("[NFC Hook] Single read timeout - aborting scan");
        controllerRef.current?.abort();
      }
    }, timeoutMs);

    // Return a disposer for the internal timeout (optional for caller)
    return () => window.clearTimeout(to);
  }

  function stopPolling() {
    if (scanIntervalRef.current !== undefined) {
      window.clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = undefined;
    }
  }

  function stopScan() {
    stopPolling();
    controllerRef.current?.abort();
    // Return to default mode for next call
    suppressRescanRef.current = false;
  }

  async function writeText(text: string) {
    if (!isSupported) throw new Error("Web NFC not supported");
    const reader = readerRef.current ?? new (window as any).NDEFReader();
    readerRef.current = reader;
    await reader.write({ records: [{ recordType: "text", data: text }] });
  }

  return {
    isSupported,
    startScan,
    startSingleRead,
    stopScan,
    writeText,
  };
}
