// Loader for sites/ga4-properties.json — FQDN → { slug, propertyId } mapping.
// Filters out underscore-prefixed keys (_meta, _comment, ...) per spec §3 M10.
// Triple naming convention per D-2026-04-28-site-naming-convention :
//   - domain : FQDN clé (ex: "fiduciaire-genevoise.ch")
//   - slug   : lowercase URL-safe (ex: "fg")
//   - propertyId : GA4 property ID, 8-12 digits

export type SiteEntry = {
  domain: string;
  slug: string;
  propertyId: string;
};

export async function loadSiteMapping(path: string): Promise<SiteEntry[]> {
  const raw = JSON.parse(await Deno.readTextFile(path));
  return Object.entries(raw)
    .filter(([key]) => !key.startsWith("_"))
    .map(([domain, value]) => {
      const v = value as { slug: string; propertyId: string };
      return { domain, slug: v.slug, propertyId: v.propertyId };
    });
}
