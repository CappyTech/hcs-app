const logger = require('../services/loggerService');

function getReceiptNotes(client, receiptId) {
  return new Promise((resolve, reject) => {
    const receiptNotesParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD,
      ReceiptId: receiptId,
    };

    client.GetReceiptNotes(receiptNotesParams, (error, result) => {
      if (error) {
        logger.error('Error calling GetReceiptNotes method: '+ error);
        return reject(error);
      }

      // Safely handle the response structure
      const receiptNotes = result?.GetReceiptNotesResponse?.GetReceiptNotesResult;
      
      if (receiptNotes && receiptNotes.ReceiptNotes) {
        // Ensure it's always returned as an array
        const notesArray = Array.isArray(receiptNotes.ReceiptNotes)
          ? receiptNotes.ReceiptNotes
          : [receiptNotes.ReceiptNotes];
        
        resolve(notesArray);
      } else {
        //logger.info('No notes found for the given receipt.');
        resolve([]);
      }
    });
  });
}

module.exports = getReceiptNotes;