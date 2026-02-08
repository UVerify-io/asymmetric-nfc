# UVerify Asymmetric NFC Library

This library provides a set of functions for working with React and asymmetric NFC tags using EdDSA signatures. It allows you to read and verify signatures from NFC LPC8N04 tags.

## Installation

```zsh
npm install @uverify/asymmetric-nfc
```

## Testing

For testing purposes, you can use the provided React app, which contains a sample Website that demonstrates how to use the library to read and verify signatures from NFC tags. To run the react app, follow these steps:

1. Install the dependencies:

   ```zsh
   cd example
   npm install
   ```

2. Start the development server:

   ```zsh
   npm run dev:expose
   ```

3. Make sure you have enabled NFC from insecure origins in your browser settings. You can do this by navigating in your *mobile chrome browser* to `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and adding e.g. `http://192.168.178.44:5173` to the list of allowed origins. Make sure to *replace this example IP address and port* with the correct values for your setup (visible in the terminal output when running `npm run dev:expose`).