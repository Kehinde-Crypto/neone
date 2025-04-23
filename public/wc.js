// Initialize WalletConnect
let connector = null;

// DOM elements
const connectButton = document.getElementById('connect-button');
const statusElement = document.getElementById('status');

// Initialize Telegram WebApp
const tg = window.Telegram.WebApp;
tg.expand();

// Connect button click handler
connectButton.addEventListener('click', async () => {
  try {
    // Create a new connector
    connector = new WalletConnect.default({
      bridge: 'https://bridge.walletconnect.org',
      qrcodeModal: WalletConnectQRCodeModal.default
    });

    // Subscribe to connection events
    connector.on('connect', (error, payload) => {
      if (error) {
        console.error('Connection error:', error);
        statusElement.textContent = `Error: ${error.message}`;
        statusElement.classList.add('error');
        return;
      }

      // Get connected accounts and chain ID
      const { accounts, chainId } = payload.params[0];
      const account = accounts[0];

      // Update UI
      statusElement.textContent = `Connected: ${account}`;
      statusElement.classList.add('connected');
      statusElement.classList.remove('error');
      connectButton.textContent = 'Connected';
      connectButton.disabled = true;

      // Send data back to Telegram bot
      const data = {
        account,
        chainId
      };

      // Send data to Telegram bot
      tg.sendData(JSON.stringify(data));
      tg.close();
    });

    connector.on('disconnect', (error, payload) => {
      if (error) {
        console.error('Disconnect error:', error);
      }
      
      // Reset UI
      statusElement.textContent = 'Disconnected';
      statusElement.classList.remove('connected');
      statusElement.classList.remove('error');
      connectButton.textContent = 'Connect Wallet';
      connectButton.disabled = false;
    });

    connector.on('error', (error) => {
      console.error('WalletConnect error:', error);
      statusElement.textContent = `Error: ${error.message}`;
      statusElement.classList.add('error');
    });

    // Create a new session
    if (!connector.connected) {
      await connector.createSession();
    }
  } catch (error) {
    console.error('Error connecting to wallet:', error);
    statusElement.textContent = `Error: ${error.message}`;
    statusElement.classList.add('error');
  }
});

// Handle page unload
window.addEventListener('beforeunload', () => {
  if (connector && connector.connected) {
    connector.killSession();
  }
}); 