// Which design boards make up each page of the site.
// desktop / mobile = board file names in design/boards/ (without .dc.html).
// tabletMobile: iPads and other touch tablets get the mobile board (homepage + menu only, per the spec).
export const SITE = {
  name: 'Ben Weiller',
  origin: 'https://benweiller.com',
  description: 'the portfolio of an advertising creative/copy/writer',
  build: Date.now().toString(36),
};

export const ROUTES = [
  { path: '/', desktop: 'Bloburblur', mobile: 'Mobile-Home', tabletMobile: true, title: '' },
  { path: '/work/', desktop: 'Menu-Blob-Bold', mobile: 'Mobile-Menu-List', tabletMobile: true, preload: true, up: '/', down: '/who-me/', title: 'selected works' },
  { path: '/kia-k5-gt/', desktop: 'Project-Kia-v2', mobile: 'Mobile-Kia-v2', title: 'KIA K5 GT' },
  { path: '/kia-x-line/', desktop: 'Project-Kia-XLine', mobile: 'Mobile-Kia-XLine', title: 'KIA X-LINE' },
  { path: '/kia-ev9-ev6/', desktop: 'Project-Kia-EV', mobile: 'Mobile-Kia-EV', title: 'KIA EV9 & EV6' },
  { path: '/san-diego-zoo/', desktop: 'Project-San-Diego-Zoo', mobile: 'Mobile-San-Diego-Zoo', title: 'SAN DIEGO ZOO' },
  { path: '/heelys/', desktop: 'Project-Heelys', mobile: 'Mobile-Heelys', title: 'HEELYS' },
  { path: '/vizio/', desktop: 'Project-Vizio', mobile: 'Mobile-Vizio', title: 'VIZIO' },
  { path: '/dropbox/', desktop: 'Project-Dropbox', mobile: 'Mobile-Dropbox', title: 'DROPBOX' },
  { path: '/jollibee/', desktop: 'Project-Jollibee', mobile: 'Mobile-Jollibee', title: 'JOLLIBEE' },
  { path: '/speak-your-vote/', desktop: 'Project-Speak-Your-Vote', mobile: 'Mobile-Speak-Your-Vote', title: 'SPEAK YOUR VOTE' },
  { path: '/motel-6/', desktop: 'Project-Motel-6', mobile: 'Mobile-Motel-6', title: 'MOTEL 6' },
  { path: '/bmw/', desktop: 'Project-BMW', mobile: 'Mobile-BMW', title: 'BMW X5/X6' },
  { path: '/vicks-vaporub/', desktop: 'Project-Vicks', mobile: 'Mobile-Vicks', title: 'VICKS VAPORUB' },
  { path: '/who-me/', desktop: 'About-A', mobile: 'Mobile-About', up: '/work/', down: '/contact/', title: 'who, me?' },
  { path: '/contact/', desktop: 'Contact-A', mobile: 'Mobile-Contact', up: '/who-me/', title: 'contact' },
  { path: '/404', desktop: 'Page-404', mobile: 'Mobile-404', title: '404' },
];

// Boards that aren't pages of their own (alts, older versions) but may still be linked from a board.
export const ALIASES = {
  'Menu-Blob-Bold-Alt': '/work/', 'Menu-Grid': '/work/', 'Mobile-Menu-Scroll': '/work/', 'Mobile-Menu-Small': '/work/', 'Mobile-Menu': '/work/',
  'Contact-C': '/contact/', 'Contact-A-Blob': '/contact/', 'Contact-A-Blob2': '/contact/', 'Contact': '/contact/',
  'Main': '/', 'Bloburblur-v1': '/', 'About': '/who-me/',
};
