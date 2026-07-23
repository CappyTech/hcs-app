# hcs-app — The Platform

hcs-app is the main web application for **Heron Constructive Solutions LTD**. It is the central platform for CIS compliance, HR, fleet management, attendance, document handling, and dashboards.

**hcs-app is provider-agnostic.** It reads financial data from the **REST** MongoDB namespace without knowing or caring which sync service wrote it. Today that's KashFlow via [hcs-sync](https://github.com/cappytech/hcs-sync); tomorrow it could be Xero, QuickBooks, or any other adapter that conforms to the same REST schema contract. hcs-app also manages its own namespaces (**INTERNAL** for users, employees, attendance, etc. and **PAPERLESS** for OCR documents).

Where hcs-app does call an external API directly (e.g. `kashflowSessionService.js` for KashFlow purchase creation, `paperlessController.js` for Paperless-ngx cross-referencing), those are **hcs-app's own integrations** — not shared with any sync service. VAT rates are read from the REST namespace (synced by hcs-sync).

---

## Repository Guidelines

> **Before writing any EJS view or UI change, read [`docs/UI-GUIDELINES.md`](docs/UI-GUIDELINES.md).** It defines the card patterns, colour system, button classes, form conventions, CSRF usage, flash message rules, and the strict no-inline-script constraint.

- Use Node.js 24.
- Install dependencies with `npm install`.
- Run the unit tests with `npm test` before committing.
- If you modify files in the `e2e/` folder, run the end-to-end tests with `npx playwright test`.
- Ensure `git status` reports a clean working tree before you finish.
- Use Git Bash as the terminal.
- Trace from `app.js` that any new file is included at some point, or is a child of another file that is included in `app.js`.
- Do **not** use `mongoose/views/mongoose/` — always use `mongoose/views/tailwindcss/`.
- The `kashflowAPI/` folder is unused. Data sync is handled by [hcs-sync](https://github.com/cappytech/hcs-sync).

---

## Internal API Documentation

The file `mongoose/config/apiDocsConfig.js` is the **single source of truth** for the internal KashFlow REST API reference. It is served at `/help/api` (admin only).

**Structure:**
- Top-level array of `group` objects (one per resource, e.g. Purchases).
- Each group has an `operations[]` array of individual endpoints.
- Each operation has:
  - `request.fields[]` — fields that **can/should be sent** in the request body.
  - `response.fields[]` — fields that are **read-only** (returned by KashFlow but must not be sent).
  - `notes[]` — freeform integration callouts.
- Fields use `required: true | false | 'conditional'` and optionally `children[]` for nested objects/arrays.

**Minimal skeleton for a new operation:**
```js
{
  id: 'purchases',           // anchor slug for the sidebar + URL hash
  tag: 'Purchases',          // sidebar heading
  icon: 'bi-receipt',        // Bootstrap Icons class
  colorClass: 'text-blue-600 dark:text-blue-400',
  bgClass: 'bg-blue-500',
  borderClass: 'border-blue-500',
  operations: [
    {
      id: 'purchases-create',        // unique slug
      method: 'POST',                // GET | POST | PUT | DELETE | PATCH
      path: '/purchases',
      summary: 'Create Purchase',
      description: 'One sentence.',
      request: {
        fields: [
          { name: 'SupplierCode', type: 'string',  required: 'conditional', description: '...' },
          { name: 'LineItems',    type: 'array',   required: true,          description: '...',
            children: [
              { name: 'NominalCode', type: 'integer', required: false, description: '...' },
            ]
          },
        ],
      },
      response: {
        status: 201,
        description: 'Read-only fields returned by KashFlow.',
        fields: [
          { name: 'Id',           type: 'integer', description: 'Internal KashFlow ID.' },
          { name: 'SupplierName', type: 'string',  description: 'Resolved from SupplierCode.' },
        ],
      },
      notes: [
        'Any important integration gotcha goes here.',
      ],
    },
  ],
}
```

**When to update this file:**
- When a new KashFlow endpoint is integrated.
- When a field's read/write status is clarified from the Swagger spec.
- When a new child field is discovered (e.g. `StockInfo` sub-fields).

**How new operations are added (the workflow):**
The user pastes a raw Swagger operation (request body schema + response schema) and the agent is responsible for:
1. Identifying which fields belong in `request.fields[]` — i.e. fields present in the **request body schema**.
2. Identifying which fields belong in `response.fields[]` — i.e. fields that appear **only in the response** and must NOT be sent in requests (e.g. computed totals, resolved names, server-assigned IDs, permalinks).
3. Writing up descriptions and setting `required` correctly based on the Swagger annotations.
4. Pushing the new operation into the correct group (or creating a new group if it's a new resource).

**Example user prompt format** (the user pastes raw Swagger output like this):

```
/purchases  Create purchase
Response Class (Status 201)
{
  "Number": 0,
  "IssuedDate": "string",
  "DueDate": "string",
  "SupplierName": "string",
  "SupplierCode": "string",
  "SupplierReference": "string",
  "GrossAmount": 0,
  "LineItems": [
    {
      "NominalId": 0,
      "ProductName": "string",
      "HomeCurrencyRate": 0,
      "ProjectName": "string",
      "HomeCurrencyImportDuty": 0,
      "DisableDisallowed": true,
      "ProjectNumber": 0,
      "NominalName": "string",
      "ImportDuty": 0,
      "StockInfo": {
        "Name": "string",
        "QuantityInStock": 0,
        "ApplicableOn": "string",
        "Received": true,
        "StockReceivedOn": "string"
      },
      "Number": 0,
      "Description": "string",
      "Quantity": 0,
      "Rate": 0,
      "VATLevel": 0,
      "VATExempt": true,
      "VATAmount": 0,
      "NominalCode": 0,
      "ProductCode": "string",
      "TaxCode": "string",
      "Disallowed": true
    }
  ],
  "PaymentLines": [
    {
      "BulkPaymentNumber": 0,
      "Permalink": "string",
      "PaymentProcessorEnumValue": 0,
      "IsPaymentCreditNote": true,
      "VATReturnId": 0,
      "Id": 0,
      "Date": "string",
      "BulkId": 0,
      "BFSTransactionId": 0,
      "PaymentProcessor": 0,
      "AccountId": 0,
      "Note": "string",
      "Method": 0,
      "Amount": 0
    }
  ],
  "Permalink": "string",
  "AdditionalFieldValue": "string",
  "PreviousNumber": 0,
  "NextNumber": 0,
  "IsWhtDeductionToBeApplied": true,
  "StockManagementApplicable": true,
  "Id": 0,
  "PaidDate": "string",
  "VATAmount": 0,
  "NetAmount": 0,
  "TotalPaidAmount": 0,
  "CISRCNetAmount": 0,
  "CISRCVatAmount": 0,
  "Status": "string",
  "Currency": {
    "Name": "string",
    "Symbol": "string",
    "DisplaySymbolOnRight": true,
    "Code": "string",
    "ExchangeRate": 0
  },
  "HomeCurrencyGrossAmount": 0,
  "OverdueDays": 0,
  "ProjectNumber": 0,
  "ProjectName": "string",
  "TradeBorderType": "string",
  "FileCount": 0,
  "DueAmount": 0,
  "IsEmailSent": true,
  "VATReturnId": 0,
  "IsCISReverseCharge": true,
  "Type": "string"
}

Parameters — body (purchaseRequest, required):
{
  "Number": 0,
  "IssuedDate": "string",
  "DueDate": "string",
  "SupplierCode": "string",
  "SupplierReference": "string",
  "Currency": {
    "Code": "string",
    "ExchangeRate": 0
  },
  "LineItems": [
    {
      "ProjectNumber": 0,
      "NominalName": "string",
      "ImportDuty": 0,
      "StockInfo": {
        "Name": "string",
        "QuantityInStock": 0,
        "ApplicableOn": "string",
        "Received": true,
        "StockReceivedOn": "string"
      },
      "Number": 0,
      "Description": "string",
      "Quantity": 0,
      "Rate": 0,
      "VATLevel": 0,
      "VATExempt": true,
      "VATAmount": 0,
      "NominalCode": 0,
      "ProductCode": "string",
      "TaxCode": "string",
      "Disallowed": true
    }
  ],
  "PaymentLines": [
    {
      "BankTransactionId": 0,
      "Id": 0,
      "Date": "string",
      "BulkId": 0,
      "BFSTransactionId": 0,
      "PaymentProcessor": 0,
      "AccountId": 0,
      "Note": "string",
      "Method": 0,
      "Amount": 0
    }
  ],
  "ProjectNumber": 0,
  "AdditionalFieldValue": "string",
  "IsCISReverseCharge": true,
  "Type": "string"
}

Response Messages:
  400 — Invalid parameters  { "Message": "string", "Error": "string" }
  401 — Unauthorized Access { "Message": "string", "Error": "string" }
```

The agent must diff the two JSON objects: any field present **only in the response** (or present in both but clearly server-computed, e.g. `GrossAmount`, `SupplierName`, `Permalink`, `Status`) goes into `response.fields[]`. Everything in the request body schema goes into `request.fields[]`.

The view is `mongoose/views/tailwindcss/help/api.ejs`. The controller handler is `exports.getApiDocs` in `mongoose/controllers/helpController.js`. The route is `GET /help/api` in `mongoose/routes/helpRoutes.js`.
