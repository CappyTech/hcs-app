import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findVatNumbersInText } from '../public/js/invoice-line-finder.js';
import entrySvc from '../mongoose/services/paperless/documentEntryService.js';

/**
 * The supplier's VAT number printed in a footer the PDF's text layer doesn't
 * carry (drawn as an image or outlines), but Paperless's OCR text does.
 * Everything here is made up.
 */

const { documentVatNumbers, invoiceProblems, vatCase } = entrySvc;

const OUR_VAT = 'GB 111 2222 33';
const OCR = `Example Landscapes
1 Example Road, Anytown AB1 2CD
INVOICE
Invoice No EL-2041 Date 05/10/2026
To: Example Customer Ltd, 2 Sample Street, Othertown ZZ9 9ZZ
Our VAT No ${OUR_VAT}
Hedge cutting 200.00
VAT 20% 40.00
Total 240.00
EORI GB987654321000
VAT Registration Number GB 987654321
BANK DETAILS: EXAMPLE LANDSCAPES`;

const company = { names: ['Example Customer Ltd'], address: '2 Sample Street, Othertown ZZ9 9ZZ' };
const values = { invoiceNumber: 'EL-2041', invoiceDate: '2026-10-05', totalVat: '40' };
const vatWarning = (problems) => problems.filter((p) => /VAT number/.test(p));

describe('VAT numbers in the OCR text', () => {
  it('finds a VAT number on a line that says VAT, or with GB, and skips an EORI number', () => {
    assert.deepEqual(findVatNumbersInText(OCR), ['111222233', '987654321']);
    assert.deepEqual(findVatNumbersInText('Tel 0151 123 4567\nAccount 123456789'), [], 'a number with no VAT label is not one');
    assert.deepEqual(findVatNumbersInText(''), []);
  });

  it('adds them to what the PDF reader found, without our own', () => {
    const noPdfVat = { reading: { vatNumbers: [] }, ocrText: OCR };
    assert.deepEqual(documentVatNumbers(noPdfVat, OUR_VAT), ['987654321']);
    const both = { reading: { vatNumbers: [{ number: '987654321' }] }, ocrText: OCR };
    assert.deepEqual(documentVatNumbers(both, OUR_VAT), ['987654321'], 'the same number once');
    assert.deepEqual(documentVatNumbers({ reading: { vatNumbers: [{ number: 'GB 555 6666 77' }] } }, OUR_VAT), ['555666677']);
    assert.deepEqual(documentVatNumbers(null), []);
  });
});

describe('the invoice checks', () => {
  it('a VAT number only in the OCR text means no "no VAT number" warning', () => {
    const doc = { reading: { vatNumbers: [] }, ocrText: OCR };
    const p = invoiceProblems({ ocrText: OCR, reading: doc.reading, docVatNumbers: documentVatNumbers(doc, OUR_VAT), values, company });
    assert.deepEqual(vatWarning(p), []);
  });

  it('with no VAT number anywhere it still warns', () => {
    const text = OCR.split('\n').filter((l) => !/VAT Registration/.test(l)).join('\n');
    const doc = { reading: { vatNumbers: [] }, ocrText: text };
    const p = invoiceProblems({ ocrText: text, reading: doc.reading, docVatNumbers: documentVatNumbers(doc, OUR_VAT), values, company });
    assert.equal(vatWarning(p).length, 1);
    assert.match(vatWarning(p)[0], /there's no VAT number on it/);
  });

  it("when the PDF couldn't be read, says the VAT number couldn't be checked", () => {
    const text = OCR.split('\n').filter((l) => !/VAT Registration/.test(l)).join('\n');
    for (const reading of [{ error: 'boom' }, { hasText: false, vatNumbers: [] }]) {
      const p = invoiceProblems({ ocrText: text, reading, docVatNumbers: documentVatNumbers({ reading, ocrText: text }, OUR_VAT), values, company });
      assert.match(vatWarning(p)[0], /PDF itself couldn't be read to check/);
    }
  });

  it('a subcontractor whose VAT number is only in the OCR text counts as VAT-registered', () => {
    const doc = { reading: { vatNumbers: [] }, ocrText: OCR };
    const v = vatCase({ supplier: null, docVatNumbers: documentVatNumbers(doc, OUR_VAT), ocrText: OCR, totalVat: '40', lines: [] });
    assert.notEqual(v.case, 'not_registered');
  });
});
