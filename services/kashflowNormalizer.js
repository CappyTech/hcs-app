function normalizePayments(payments) {
  let extracted = [];

  if (Array.isArray(payments) && payments.every(p => typeof p === 'object' && 'PayAmount' in p)) {
    extracted = payments;
  } else if (Array.isArray(payments?.Payment?.Payment)) {
    extracted = payments.Payment.Payment;
  } else if (payments?.Payment?.Payment) {
    extracted = [payments.Payment.Payment];
  } else if (Array.isArray(payments?.Payment)) {
    extracted = payments.Payment;
  } else if (payments?.Payment) {
    extracted = [payments.Payment];
  }

  // Sanitize: Only return payments with valid PayDate and PayAmount
  return extracted
    .filter(p => p && typeof p === 'object' && p.PayDate && !isNaN(new Date(p.PayDate)))
    .map(p => ({
      PayDate: new Date(p.PayDate).toISOString(),
      PayAmount: +p.PayAmount || 0
    }));
}

module.exports = normalizePayments;