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

---

## **Prerequisites**
- **Node.js**: Version 18.x or higher.
- **npm**: Installed alongside Node.js.
- **TRON Wallet**: A multi-signature wallet with sufficient TRX balance.

---

## **Env Configuration**

- **TRON_WALLET_ADDRESS**: The address of the multi-signature wallet.
- **TRON_WALLET_PRIVATE_KEY**: The private key of the multi-signature wallet.
- **TRON_RECEIVER_ADDRESS**: The address of the receiver to transfer TRX to.
  
---

## **Logs**

Logs are stored in a daily rotated file named `logs/<date>.log`. Each log entry includes

---

## **How it works**

1. The bot starts by validating the wallet type and permissions.
2. It then monitors the wallet balance periodically.

---

## **License**
MIT License

---
