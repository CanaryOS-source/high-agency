// Provision the High Agency property group and custom contact properties in
// HubSpot. Idempotent: it creates what's missing, skips what exists, and never
// modifies a property that is already there — if someone widened a picklist in
// the portal, that's their call, not something a re-run should revert.
//
// Run this once before the first backfill, and again after adding a property to
// app/lib/hubspotSchema.ts (the single source of truth it reads).
//
// Usage:
//   node scripts/hubspot-setup.js              # create what's missing
//   node scripts/hubspot-setup.js --dry-run    # show the plan, write nothing
//
// Needs HUBSPOT_ACCESS_TOKEN (in .env or inline). It does NOT touch Firebase.
//
// The HTTP itself is app/lib/hubspot.ts — the same client the deployed app
// uses, loaded through tsx. No second implementation to drift.
const {
  loadSchema,
  loadTsModule,
  printPairs,
  requireHubspotToken,
} = require("./hubspot-common");

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  requireHubspotToken();

  const { HA_PROPERTIES, HA_GROUP_NAME, HA_GROUP_LABEL } = loadSchema();
  const hubspot = loadTsModule("app/lib/hubspot.ts");

  console.log(
    `\nHubSpot property setup — ${HA_PROPERTIES.length} properties in the registry`
  );
  console.log(`group: ${HA_GROUP_NAME} ("${HA_GROUP_LABEL}")`);
  console.log(dryRun ? "mode:  DRY RUN — nothing will be written\n" : "");

  if (dryRun) {
    const [groupExists, present] = await Promise.all([
      hubspot.hasPropertyGroup(),
      hubspot.listContactPropertyNames(),
    ]);
    console.log(
      `group ${HA_GROUP_NAME}: ${groupExists ? "already present" : "WOULD CREATE"}`
    );
    console.log("");

    let toCreate = 0;
    printPairs(
      HA_PROPERTIES.map((def) => {
        const exists = present.has(def.name);
        if (!exists) toCreate++;
        return [
          def.name,
          `${exists ? "exists — would skip" : "WOULD CREATE"}  (${def.type}/${def.fieldType})`,
        ];
      })
    );
    console.log(
      `\n${toCreate} would be created, ${HA_PROPERTIES.length - toCreate} skipped.` +
        `\nRe-run without --dry-run to apply.\n`
    );
    return;
  }

  const result = await hubspot.ensureProperties(HA_PROPERTIES);

  console.log(
    `group ${HA_GROUP_NAME}: ${result.createdGroup ? "created" : "already present"}`
  );
  console.log("");
  printPairs(
    HA_PROPERTIES.map((def) => [
      def.name,
      `${result.created.includes(def.name) ? "CREATED" : "exists — skipped"}  (${def.type}/${def.fieldType})`,
    ])
  );
  console.log(
    `\n${result.created.length} created, ${result.skipped.length} skipped.`
  );
  if (result.created.length) {
    console.log("Next: node scripts/hubspot-backfill.js --dry-run");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\nerror: ${e.message}\n`);
  process.exit(1);
});
