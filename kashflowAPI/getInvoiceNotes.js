const logger = require('../services/loggerService');

function getInvoiceNotes(client, invoiceId) {
  return new Promise((resolve, reject) => {
    const invoiceNotesParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD,
      InvoiceId: invoiceId,
    };

    client.GetInvoiceNotes(invoiceNotesParams, (error, result) => {
      if (error) {
        logger.error('Error calling GetInvoiceNotes method: '+ error);
        return reject(error);
      }

      // Safely handle the response structure
      const invoiceNotesResult = result?.GetInvoiceNotesResponse?.GetInvoiceNotesResult;
      
      if (invoiceNotesResult && invoiceNotesResult.InvoiceNotes) {
        // Ensure it's always returned as an array
        const notesArray = Array.isArray(invoiceNotesResult.InvoiceNotes)
          ? invoiceNotesResult.InvoiceNotes
          : [invoiceNotesResult.InvoiceNotes];
        
        resolve(notesArray);
      } else {
        //logger.info('No notes found for the given invoice.');
        resolve([]);
      }
    });
  });
}

module.exports = getInvoiceNotes;