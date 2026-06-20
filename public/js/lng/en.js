/* js/lng/en.js — English language pack. Registers itself with the i18n engine.  */
(function (FT) {
  "use strict";
  FT.I18n.register("en", {
    name: "English",
    nativeName: "English",
    dir: "ltr",
    strings: {
      // shell
      "brand.title": "Family Tree",
      "nav.dashboard": "Dashboard",
      "nav.people": "People",
      "nav.tree": "Tree",
      "nav.io": "Import / Export",
      "search.placeholder": "Search people\u2026",
      "lang.label": "Language",

      // common
      "common.addPerson": "+ Add person",
      "common.viewTree": "View tree",
      "common.tree": "Tree",
      "common.story": "Story",
      "common.edit": "Edit",
      "common.print": "Print",
      "common.importData": "Import data",
      "common.openViewer": "Open viewer",
      "common.manageData": "Manage data",
      "common.prev": "\u2190 Prev",
      "common.next": "Next \u2192",
      "common.loading": "Loading\u2026",

      // dashboard
      "dash.overview": "Overview",
      "dash.title": "Dashboard",
      "stat.people": "People",
      "stat.living": "Living",
      "stat.deceased": "{n} deceased",
      "stat.marriages": "Marriages",
      "stat.events": "Events",
      "stat.surnames": "Surnames",
      "stat.earliestBirth": "Earliest birth",
      "dash.recentlyEdited": "Recently edited",
      "dash.noPeople": "No people yet. Add one to begin.",
      "empty.title": "Your tree is empty",
      "empty.body": "Head to the Tree page to name your family tree and add its first person \u2014 or import a GEDCOM / JSON file.",
      "empty.start": "Start your tree",
      "quick.exploreTitle": "Explore the tree",
      "quick.exploreBody": "Walk ancestors and descendants in the interactive viewer.",
      "quick.ioTitle": "Import / Export",
      "quick.ioBody": "Load a GEDCOM file or back up your data as JSON.",

      // people
      "people.records": "Records",
      "people.title": "People",
      "people.searchPlaceholder": "Search name, occupation, birthplace\u2026",
      "people.includeNotes": "include notes & biography",
      "sort.lastName": "Last name",
      "sort.firstName": "First name",
      "sort.birthDate": "Birth date",
      "table.name": "Name",
      "table.lifespan": "Lifespan",
      "table.birthplace": "Birthplace",
      "table.occupation": "Occupation",
      "people.noMatches": "No matches",
      "people.noPeople": "No people yet",
      "people.noMatchesBody": "Try a shorter prefix, or include notes & biography.",
      "people.noPeopleBody": "Add a person or import a GEDCOM file to begin.",
      "people.living": "living",
      "people.pageInfo": "Page {page} of {pages} \u00b7 {total} {unit}",
      "people.unitMatches": "matches",
      "people.unitPeople": "people",

      // story
      "story.eyebrow": "Life story",
      "tab.narrative": "Narrative",
      "tab.timeline": "Timeline",
      "story.noEvents": "No dated events.",
      "story.notEnough": "Not enough information to compose a story yet.",
      "rel.parents": "Parents",
      "rel.children": "Children",

      // import / export
      "io.eyebrow": "Data",
      "io.title": "Import & Export",
      "io.gedImportTitle": "Import GEDCOM",
      "io.gedImportDesc": "Supports 5.5, 5.5.1, and 7.0. Unknown tags are skipped. Imported people are merged into your family tree; matching people are de-duplicated.",
      "io.gedChoose": "Choose a .ged file",
      "io.gedExportTitle": "Export GEDCOM",
      "io.gedExportDesc": "Export your family tree as GEDCOM 5.5.1 for use in other genealogy software.",
      "io.gedExportBtn": "Download GEDCOM",
      "io.jsonExportTitle": "Export JSON",
      "io.jsonExportDesc": "Lossless native backup including persons, relationships, marriages, events, and media.",
      "io.jsonExportBtn": "Download JSON backup",
      "io.jsonImportTitle": "Import JSON",
      "io.jsonImportDesc": "Restore from a native JSON backup. Imported records are merged into your single family tree.",
      "io.jsonChoose": "Choose a .json file",
      "io.dangerTitle": "Danger zone",
      "io.dangerDesc": "Permanently delete everything stored in this browser.",
      "io.dangerBtn": "Erase all data"
    }
  });
})(window.FT);
