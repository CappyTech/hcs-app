const { expect } = require('chai');
const path = require('path');

describe('validationService.validateInvoiceData', () => {
  const { validateInvoiceData } = require('../services/validationService');

  it('returns cleaned data when valid', () => {
    const data = {
      invoiceNumber: 'INV1',
      kashflowNumber: 'KF1',
      invoiceDate: '2024-01-01',
      remittanceDate: '2024-02-01',
      labourCost: 100,
      materialCost: 50,
      submissionDate: '0000-00-00 00:00:00',
    };
    const result = validateInvoiceData({ ...data });
    expect(result.remittanceDate).to.equal('2024-02-01');
    expect(result.submissionDate).to.equal(null);
  });

  it('throws when invoiceNumber missing', () => {
    const data = {
      invoiceNumber: '',
      kashflowNumber: 'KF1',
      invoiceDate: '2024-01-01',
      labourCost: 10,
      materialCost: 5,
    };
    expect(() => validateInvoiceData(data)).to.throw('invoiceNumber');
  });
});

describe('encryptionService encrypt/decrypt', () => {
  before(() => {
    process.env.ENCRYPTION_KEY = 'test-secret';
    // clear require cache so service reads env
    delete require.cache[require.resolve('../services/encryptionService')];
  });
  const encryptionService = require('../services/encryptionService');

  it('round trips text correctly', () => {
    const encrypted = encryptionService.encrypt('hello');
    const decrypted = encryptionService.decrypt(encrypted);
    expect(decrypted).to.equal('hello');
  });

  it('throws on invalid encrypted text', () => {
    expect(() => encryptionService.decrypt('badtext')).to.throw();
  });
});

describe('taxService.calculateTaxYearAndMonth', () => {
  const { calculateTaxYearAndMonth } = require('../services/taxService');

  it('calculates correct tax year before April 6th', () => {
    const { taxYear, taxMonth } = calculateTaxYearAndMonth('2023-04-05T00:00:00Z');
    expect(taxYear).to.equal(2022);
    expect(taxMonth).to.equal(12);
  });

  it('calculates start of new tax year', () => {
    const { taxYear, taxMonth } = calculateTaxYearAndMonth('2023-04-06T00:00:00Z');
    expect(taxYear).to.equal(2023);
    expect(taxMonth).to.equal(1);
  });
});
