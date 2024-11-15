require('dotenv').config();
const { TronWeb } = require('tronweb');
const winston = require('winston');

// Configure Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        // Write logs to file
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        // Also log to console
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// TronWeb configuration
const tronWeb = new TronWeb({
    fullHost: 'https://api.trongrid.io'
});

// Log startup configuration
logger.info('Starting TRON transaction bot');
logger.info(`Using TRON network: ${tronWeb.fullNode.host}`);

const senderPrivateKey = process.env.SENDER_PRIVATE_KEY;
const multiSigWalletAddress = process.env.MULTISIGWALLETADDRESS;
const receiverAddress = process.env.RECIEVER_ADDRESS;
const thresholdBalance = 820000;

tronWeb.setPrivateKey(senderPrivateKey);

logger.info('Configuration loaded', {
    multiSigWalletAddress,
    receiverAddress,
    thresholdBalance
});

async function checkBalanceAndSendTransaction() {
    logger.info('Initiating balance check');
    try {
        const balance = await tronWeb.trx.getBalance(multiSigWalletAddress);
        logger.info('Balance retrieved', {
            balance,
            walletAddress: multiSigWalletAddress
        });

        if (balance >= thresholdBalance) {
            logger.info('Balance exceeds threshold, initiating transfer', {
                balance,
                threshold: thresholdBalance
            });
            await sendAllTRX(balance);
        } else {
            logger.info('Balance below threshold, no action needed', {
                balance,
                threshold: thresholdBalance
            });
        }
    } catch (error) {
        logger.error('Failed to check balance', {
            error: error.message,
            stack: error.stack
        });
    }
}

async function sendAllTRX(balance) {
    logger.info('Initiating TRX transfer');
    try {
        const estimatedFee = 100000;
        const amountToSend = balance - estimatedFee;

        logger.info('Calculated transfer amount', {
            totalBalance: balance,
            estimatedFee,
            amountToSend
        });

        if (amountToSend <= 0) {
            logger.error('Insufficient balance after fee deduction', {
                balance,
                estimatedFee
            });
            return;
        }

        logger.info('Building transaction');
        const tx = await tronWeb.transactionBuilder.sendTrx(
            receiverAddress,
            amountToSend,
            tronWeb.defaultAddress.base58
        );

        logger.info('Signing transaction');
        const signedTx = await tronWeb.trx.sign(tx);
        
        logger.info('Broadcasting transaction');
        const broadcastResponse = await tronWeb.trx.sendRawTransaction(signedTx);

        if (broadcastResponse.result) {
            logger.info('Transaction successful', {
                response: broadcastResponse,
                amount: amountToSend,
                receiver: receiverAddress
            });
        } else {
            logger.error('Transaction failed', {
                response: broadcastResponse
            });
            throw new Error('Broadcasting transaction failed');
        }
    } catch (error) {
        if (error.message.includes('insufficient balance')) {
            logger.error('Insufficient balance error', {
                error: error.message,
                balance
            });
        } else if (error.message.includes('network issue')) {
            logger.warn('Network issue detected, scheduling retry', {
                error: error.message
            });
            setTimeout(() => sendAllTRX(balance), 10000);
        } else {
            logger.error('Transaction error', {
                error: error.message,
                stack: error.stack
            });
        }
    }
}

// Start the periodic checks
logger.info('Starting periodic balance checks');
setInterval(checkBalanceAndSendTransaction, 60000);

// Initial check on startup
checkBalanceAndSendTransaction();

