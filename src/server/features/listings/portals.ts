// Fork (ypsum): German directories, review sites and industry portals the
// listing check looks for. Extend here; projects add their own per scan
// (extraPortals). Every portal is checked through Google results only: one
// search per business, throttled, no crawling of the directories themselves
// (database right § 87b UrhG and the portals' terms).

export type ListingPortalGroup =
  | "telefonbuch"
  | "branchenbuch"
  | "bewertung"
  | "karte"
  | "plattform"
  | "gesundheit"
  | "handwerk"
  | "beauty"
  | "gastronomie";

export type ListingPortal = {
  id: string;
  name: string;
  /** Matched as the host or any subdomain of it. */
  domains: string[];
  group: ListingPortalGroup;
};

const portal = (
  id: string,
  name: string,
  group: ListingPortalGroup,
  ...domains: string[]
): ListingPortal => ({ id, name, group, domains });

export const LISTING_PORTALS: ListingPortal[] = [
  portal("dasoertliche", "Das Örtliche", "telefonbuch", "dasoertliche.de"),
  portal("gelbeseiten", "Gelbe Seiten", "telefonbuch", "gelbeseiten.de"),
  portal(
    "dastelefonbuch",
    "Das Telefonbuch",
    "telefonbuch",
    "dastelefonbuch.de",
  ),
  portal("11880", "11880", "telefonbuch", "11880.com"),
  portal(
    "bundestelefonbuch",
    "BundesTelefonbuch",
    "telefonbuch",
    "bundestelefonbuch.de",
  ),
  portal("golocal", "GoLocal", "branchenbuch", "golocal.de"),
  portal("goyellow", "GoYellow", "branchenbuch", "goyellow.de"),
  portal("meinestadt", "meinestadt.de", "branchenbuch", "meinestadt.de"),
  portal(
    "stadtbranchenbuch",
    "Stadtbranchenbuch",
    "branchenbuch",
    "stadtbranchenbuch.com",
    "stadtbranchenbuch.de",
  ),
  portal("yellowmap", "YellowMap", "branchenbuch", "yellowmap.de"),
  portal("cylex", "Cylex", "branchenbuch", "cylex.de"),
  portal(
    "branchenbuchdeutschland",
    "Branchenbuch Deutschland",
    "branchenbuch",
    "branchenbuchdeutschland.de",
  ),
  portal(
    "marktplatz-mittelstand",
    "Marktplatz Mittelstand",
    "branchenbuch",
    "marktplatz-mittelstand.de",
  ),
  portal("dialo", "Dialo", "branchenbuch", "dialo.de"),
  portal("auskunft", "auskunft.de", "branchenbuch", "auskunft.de"),
  portal("acompio", "Acompio", "branchenbuch", "acompio.de"),
  portal("koomio", "Koomio", "branchenbuch", "koomio.com", "koomio.de"),
  portal(
    "showmelocal",
    "ShowMeLocal",
    "branchenbuch",
    "showmelocal.com",
    "showmelocal.de",
  ),
  portal("brownbook", "Brownbook", "branchenbuch", "brownbook.net"),
  portal(
    "infoisinfo",
    "InfoIsInfo",
    "branchenbuch",
    "infoisinfo.com",
    "infoisinfo-de.com",
  ),
  portal("tellows", "tellows", "branchenbuch", "tellows.de"),
  portal(
    "t-online-branchen",
    "t-online Branchen",
    "branchenbuch",
    "branchen.t-online.de",
  ),
  portal("wogibtswas", "wogibtswas", "branchenbuch", "wogibtswas.de"),
  portal("hotfrog", "Hotfrog", "branchenbuch", "hotfrog.de"),
  portal("tupalo", "Tupalo", "branchenbuch", "tupalo.net", "tupalo.de"),
  portal("kaufda", "KaufDA", "branchenbuch", "kaufda.de"),
  portal("europages", "Europages", "branchenbuch", "europages.de"),
  portal("kennstdueinen", "kennstdueinen", "branchenbuch", "kennstdueinen.de"),
  portal(
    "oeffnungszeitenbuch",
    "Öffnungszeitenbuch",
    "branchenbuch",
    "oeffnungszeitenbuch.de",
  ),
  portal(
    "oeffnungszeiten",
    "oeffnungszeiten.com",
    "branchenbuch",
    "oeffnungszeiten.com",
  ),
  portal("infobel", "Infobel", "branchenbuch", "infobel.com"),
  portal(
    "werkenntdenbesten",
    "Wer kennt den Besten",
    "bewertung",
    "werkenntdenbesten.de",
  ),
  portal("yelp", "Yelp", "bewertung", "yelp.de", "yelp.com"),
  portal(
    "tripadvisor",
    "Tripadvisor",
    "bewertung",
    "tripadvisor.de",
    "tripadvisor.com",
  ),
  portal(
    "meinungsmeister",
    "Meinungsmeister",
    "bewertung",
    "meinungsmeister.de",
  ),
  portal("provenexpert", "ProvenExpert", "bewertung", "provenexpert.com"),
  portal("trustpilot", "Trustpilot", "bewertung", "trustpilot.com"),
  portal("foursquare", "Foursquare", "karte", "foursquare.com"),
  portal("mapquest", "MapQuest", "karte", "mapquest.com"),
  portal("waze", "Waze", "karte", "waze.com"),
  portal("facebook", "Facebook", "plattform", "facebook.com"),
  portal("instagram", "Instagram", "plattform", "instagram.com"),
  portal("jameda", "Jameda", "gesundheit", "jameda.de"),
  portal("doctolib", "Doctolib", "gesundheit", "doctolib.de"),
  portal("docinsider", "DocInsider", "gesundheit", "docinsider.de"),
  portal("sanego", "Sanego", "gesundheit", "sanego.de"),
  portal("arzt-auskunft", "Arzt-Auskunft", "gesundheit", "arzt-auskunft.de"),
  portal("therapeuten", "Therapeuten.de", "gesundheit", "therapeuten.de"),
  portal("myhammer", "MyHammer", "handwerk", "myhammer.de"),
  portal("check24-profis", "Check24 Profis", "handwerk", "check24.de"),
  portal("blauarbeit", "Blauarbeit", "handwerk", "blauarbeit.de"),
  portal("houzz", "Houzz", "handwerk", "houzz.de"),
  portal("treatwell", "Treatwell", "beauty", "treatwell.de"),
  portal("planity", "Planity", "beauty", "planity.com"),
  portal("booksy", "Booksy", "beauty", "booksy.com"),
  portal("fresha", "Fresha", "beauty", "fresha.com"),
  portal("thefork", "TheFork", "gastronomie", "thefork.de"),
  portal("speisekarte", "Speisekarte.de", "gastronomie", "speisekarte.de"),
  portal("opentable", "OpenTable", "gastronomie", "opentable.de"),
  portal("lieferando", "Lieferando", "gastronomie", "lieferando.de"),
  portal("quandoo", "Quandoo", "gastronomie", "quandoo.de"),
];
