# **TRON Automated Transaction Bot**

This project is a bot designed to automate TRON (TRX) transactions using a multi-signature wallet. It monitors the wallet's balance periodically and transfers TRX to a specified receiver when certain conditions are met.

---

## **Features**
- Automates TRX transfers from a multi-signature wallet.
- Monitors wallet balance periodically.
- Logs transactions and errors using Winston with daily rotation.
- Validates wallet type and permissions for security.
- Configurable via environment variables.
- Graceful shutdown support to ensure smooth operation.
- WalletConnect integration for easy wallet import.

---

## **Prerequisites**
- **Node.js**: Version 18.x or higher.
- **npm**: Installed alongside Node.js.
- **TRON Wallet**: A multi-signature wallet with sufficient TRX balance.
- **Express Server**: For serving the WalletConnect web app.

---

## **Env Configuration**

- **TELEGRAM_BOT_TOKEN**: Your Telegram bot token.
- **ENCRYPTION_KEY**: Key for encrypting sensitive data.
- **DATABASE_URL**: PostgreSQL connection string.
- **LOG_DIR**: Directory for storing logs.
- **WEBAPP_URL**: URL for the WalletConnect web app (e.g., https://your-domain.com/wc).
  
---

## **Logs**

Logs are stored in a daily rotated file named `logs/<date>.log`. Each log entry includes

---

## **How it works**

1. The bot starts by validating the wallet type and permissions.
2. It then monitors the wallet balance periodically.
3. When funds are detected, it automatically transfers them to the specified receiver.

---

## **WalletConnect Integration**

The bot now supports importing wallets using WalletConnect:

1. Use the `/import` command to start the WalletConnect flow.
2. Click the "Connect Wallet" button to open the WalletConnect web app.
3. Scan the QR code with your wallet app or use a deep link.
4. Approve the connection in your wallet.
5. Enter the receiver address when prompted.
6. The wallet will be imported and monitored for funds.

This provides a more secure way to import wallets without sharing private keys.

---

## **License**
MIT License

---
