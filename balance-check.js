require('dotenv').config();
const { TronWeb } = require('tronweb');
const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

// Configure Winston logger
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.json()
    ),
    transports: [
        new transports.DailyRotateFile({
            filename: 'logs/error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxFiles: '14d'
        }),
        new transports.DailyRotateFile({
            filename: 'logs/combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '14d'
        }),
        new transports.Console({
            format: format.combine(
                format.colorize(),
                format.simple()
            )
        })
    ]
});

// Add at the top of your file after the logger configuration
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', {
        error: error.message,
        stack: error.stack
    });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', {
        reason,
        promise
    });
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

// Add after require statements
function validateEnvironment() {
    const required = [
        'SENDER_PRIVATE_KEY',
        'MULTISIGWALLETADDRESS',
        'RECIEVER_ADDRESS'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        logger.error('Missing required environment variables', { missing });
        process.exit(1);
    }
}

// Call it before using any env vars
validateEnvironment();

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

async function sendAllTRX(balance, retryCount = 0) {
    const MAX_RETRIES = 3;
    logger.info('Initiating TRX transfer', { retryCount });
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
                txID: broadcastResponse.txid,
                response: broadcastResponse,
                amount: amountToSend,
                receiver: receiverAddress,
                timestamp: new Date().toISOString()
            });
        } else {
            logger.error('Transaction failed', {
                response: broadcastResponse
            });
            throw new Error('Broadcasting transaction failed');
        }
    } catch (error) {
        if (retryCount >= MAX_RETRIES) {
            logger.error('Max retries reached, giving up', {
                error: error.message,
                retryCount
            });
            return;
        }

        if (error.message.includes('insufficient balance')) {
            logger.error('Insufficient balance error', {
                error: error.message,
                balance
            });
        } else if (error.message.includes('network issue')) {
            logger.warn('Network issue detected, scheduling retry', {
                error: error.message,
                retryCount
            });
            setTimeout(() => sendAllTRX(balance, retryCount + 1), 10000 * (retryCount + 1));
        } else {
            logger.warn('General error detected, scheduling retry', {
                error: error.message,
                retryCount
            });
            setTimeout(() => sendAllTRX(balance, retryCount + 1), 5000 * (retryCount + 1));
        }
    }
}

// Add before starting the interval
let intervalId;

function gracefulShutdown() {
    logger.info('Received shutdown signal, cleaning up...');
    clearInterval(intervalId);
    logger.info('Cleanup completed, shutting down');
    process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Modify the interval start
logger.info('Starting periodic balance checks');
intervalId = setInterval(checkBalanceAndSendTransaction, 60000);

// Initial check on startup
checkBalanceAndSendTransaction();

