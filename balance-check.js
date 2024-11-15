const { TronWeb } = require('tronweb');

// TronWeb configuration
const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io'
});

// Replace these with actual values
const multiSigWalletAddress = process.env.MULTISIGWALLETADDRESS; 
const receiverAddress = process.env.RECIEVER_ADDRESS;    
const senderPrivateKey = process.env.SENDER_PRIVATE_KEY;  
const thresholdBalance = 820000;                          // 0.82 TRX in SUN (1 TRX = 1,000,000 SUN)

// Set the private key for signing transactions
tronWeb.setPrivateKey(senderPrivateKey);

// Function to check the balance and send all TRX if threshold is met
async function checkBalanceAndSendTransaction() {
    try {
        const balance = await tronWeb.trx.getBalance(multiSigWalletAddress);
        console.log(`Current Balance: ${balance} SUN (1 TRX = 1,000,000 SUN)`);

        if (balance >= thresholdBalance) {
            console.log(`Balance exceeds threshold. Sending all available TRX...`);
            await sendAllTRX(balance);
        } else {
            console.log(`Balance is below threshold. No transaction initiated.`);
        }
    } catch (error) {
        console.error('Error fetching balance:', error.message);
    }
}

// Function to send all available TRX from the wallet
async function sendAllTRX(balance) {
    try {
        // Estimate transaction fee (in SUN) and calculate the amount to send
        const estimatedFee = 100000; // 100,000 SUN (0.1 TRX) is typical for a TRX transaction
        const amountToSend = balance - estimatedFee;

        if (amountToSend <= 0) {
            console.error('Insufficient balance after transaction fee deduction');
            return;
        }

        const tx = await tronWeb.transactionBuilder.sendTrx(
            receiverAddress,
            amountToSend,
            tronWeb.defaultAddress.base58
        );

        const signedTx = await tronWeb.trx.sign(tx);
        const broadcastResponse = await tronWeb.trx.sendRawTransaction(signedTx);

        if (broadcastResponse.result) {
            console.log('Transaction Successful:', broadcastResponse);
        } else {
            console.log('Transaction Failed:', broadcastResponse);
            throw new Error('Broadcasting transaction failed');
        }
    } catch (error) {
        if (error.message.includes('insufficient balance')) {
            console.error('Error: Insufficient balance to complete the transaction');
        } else if (error.message.includes('network issue')) {
            console.error('Network issue detected. Retrying in 10 seconds...');
            setTimeout(() => sendAllTRX(balance), 10000); // Retry after 10 seconds
        } else {
            console.error('Error sending TRX:', error.message);
        }
    }
}

// Set up periodic balance checks (e.g., every 1 minute)
setInterval(checkBalanceAndSendTransaction, 60000); // Check every 60 seconds
