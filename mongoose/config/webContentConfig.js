/**
 * The registry for the website content editor at /website.
 *
 * One entry per content type. Routes, list columns, form fields and the write
 * whitelist all derive from here, so adding a field to the public site is a
 * declaration rather than an edit in five places — the same config-driven habit
 * as listControllerConfig.js, and for the same reason: the failure mode of the
 * alternative is a field that exists in the model, renders in the form, and is
 * silently dropped on save because one list was not updated.
 *
 * **The `fields` array is the write whitelist.** webController builds every
 * update from it and ignores anything else in the body, so a field that is not
 * declared here cannot be written through the editor at all.
 *
 * Field types are rendered by views/tailwindcss/website/_field.ejs:
 *
 *   text · textarea · richtext · number · date · url · tags
 *   image    — a media picker: { media, alt }
 *   panel    — image plus a caption: { media, alt, caption }
 *   gallery  — repeating panels
 *   hours    — repeating { days, time }
 *   offices  — repeating { label, phone, address{line1..4, postcode} }
 *
 * Exactly **one `richtext` field per type** is allowed, because the Quill
 * initialiser in layout.ejs binds hardcoded element ids (#quill-editor,
 * #contentHtml-input) and a second instance on the page would write into the
 * first one's hidden input. tests/webContentConfig.test.js pins this.
 */

const webContentConfig = {
  'case-studies': {
    model: 'webCaseStudy',
    label: 'Case Study',
    plural: 'Case Studies',
    icon: 'bi-buildings',
    // Where this appears on the public site, shown in the editor so the person
    // writing knows what they are affecting.
    publicPath: '/studies/:slug',
    listColumns: ['title', 'client', 'location', 'status'],
    defaultSort: { sortOrder: 1, title: 1 },
    fields: [
      { name: 'title', type: 'text', label: 'Title', required: true },
      { name: 'slug', type: 'text', label: 'Slug', help: 'Left blank, this is generated from the title. Changing it changes the public URL.' },
      { name: 'client', type: 'text', label: 'Client', help: 'Leave blank until they have agreed to be named.' },
      { name: 'location', type: 'text', label: 'Location' },
      { name: 'scope', type: 'textarea', label: 'Scope of works' },
      { name: 'excerpt', type: 'textarea', label: 'Excerpt', help: 'One or two lines, shown on the index card.' },
      { name: 'card', type: 'image', label: 'Card image' },
      { name: 'before', type: 'panel', label: 'Before' },
      { name: 'after', type: 'panel', label: 'After' },
      { name: 'gallery', type: 'gallery', label: 'Gallery' },
      { name: 'contentHtml', type: 'richtext', label: 'Full write-up' },
      { name: 'socialValue', type: 'textarea', label: 'Social value note' },
      { name: 'sortOrder', type: 'number', label: 'Sort order' },
    ],
  },

  posts: {
    model: 'webPost',
    label: 'Blog Post',
    plural: 'Blog Posts',
    icon: 'bi-newspaper',
    publicPath: '/blog/:slug',
    listColumns: ['title', 'author', 'publishedAt', 'status'],
    defaultSort: { publishedAt: -1, createdAt: -1 },
    fields: [
      { name: 'title', type: 'text', label: 'Title', required: true },
      { name: 'slug', type: 'text', label: 'Slug' },
      { name: 'excerpt', type: 'textarea', label: 'Excerpt' },
      { name: 'contentHtml', type: 'richtext', label: 'Post' },
      { name: 'author', type: 'text', label: 'Byline' },
      { name: 'tags', type: 'tags', label: 'Tags', help: 'Comma separated.' },
    ],
  },

  services: {
    model: 'webService',
    label: 'Service',
    plural: 'Services',
    icon: 'bi-tools',
    publicPath: '/services',
    listColumns: ['title', 'href', 'status'],
    defaultSort: { sortOrder: 1, title: 1 },
    fields: [
      { name: 'title', type: 'text', label: 'Title', required: true },
      { name: 'slug', type: 'text', label: 'Slug' },
      { name: 'description', type: 'textarea', label: 'Description' },
      { name: 'image', type: 'image', label: 'Card image' },
      {
        name: 'href', type: 'text', label: 'Links to',
        help: 'Anything other than /contact means this service has its own page — which is also what upgrades its link in the site footer.',
      },
      { name: 'cta', type: 'text', label: 'Button label' },
      { name: 'pageTitle', type: 'text', label: 'Page title (SEO)' },
      { name: 'metaDescription', type: 'textarea', label: 'Meta description (SEO)' },
      { name: 'contentHtml', type: 'richtext', label: 'Page content' },
      { name: 'sortOrder', type: 'number', label: 'Sort order' },
    ],
  },

  accreditations: {
    model: 'webAccreditation',
    label: 'Accreditation',
    plural: 'Accreditations',
    icon: 'bi-patch-check',
    publicPath: '/accreditations',
    listColumns: ['name', 'membershipNumber', 'validTo', 'status'],
    defaultSort: { sortOrder: 1, name: 1 },
    fields: [
      { name: 'name', type: 'text', label: 'Name', required: true },
      { name: 'slug', type: 'text', label: 'Slug' },
      { name: 'logo', type: 'image', label: 'Logo' },
      { name: 'description', type: 'textarea', label: 'Description' },
      { name: 'membershipNumber', type: 'text', label: 'Membership / registration number', help: 'Procurement teams ask for this.' },
      { name: 'validFrom', type: 'date', label: 'Valid from' },
      { name: 'validTo', type: 'date', label: 'Valid to' },
      { name: 'certificateUrl', type: 'url', label: 'Certificate link' },
      { name: 'sortOrder', type: 'number', label: 'Sort order' },
    ],
  },

  settings: {
    model: 'webSiteSettings',
    label: 'Site Settings',
    plural: 'Site Settings',
    icon: 'bi-sliders',
    publicPath: '/',
    // A singleton, found by key: 'site'. There is no list and no create — the
    // routes for those are not registered.
    singleton: true,
    fields: [
      { name: 'name', type: 'text', label: 'Company name', required: true },
      { name: 'email', type: 'text', label: 'Contact email' },
      { name: 'tagline', type: 'text', label: 'Tagline' },
      { name: 'companyNumber', type: 'text', label: 'Company number', help: 'Statutory disclosure — must appear on the site.' },
      { name: 'registrationCountry', type: 'text', label: 'Registered in' },
      { name: 'companyType', type: 'text', label: 'Company type' },
      { name: 'vatNumber', type: 'text', label: 'VAT number' },
      { name: 'offices', type: 'offices', label: 'Offices' },
      { name: 'hours', type: 'hours', label: 'Opening hours' },
      { name: 'inboxMonitored', type: 'text', label: 'Inbox — monitoring note' },
      { name: 'inboxResponse', type: 'text', label: 'Inbox — response time note' },
      { name: 'ogImage', type: 'image', label: 'Social share image', help: '1200×630. Empty means the share tag is omitted rather than pointing at a missing file.' },
      { name: 'robots', type: 'text', label: 'robots' },
      { name: 'themeColor', type: 'text', label: 'Theme colour' },
      { name: 'locale', type: 'text', label: 'Locale' },
      { name: 'twitterHandle', type: 'text', label: 'X / Twitter handle' },
      { name: 'instagramHandle', type: 'text', label: 'Instagram handle' },
      { name: 'facebookHandle', type: 'text', label: 'Facebook handle' },
      { name: 'linkedinHandle', type: 'text', label: 'LinkedIn handle' },
    ],
  },
};

export default webContentConfig;
