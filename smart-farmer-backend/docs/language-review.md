# Shona and Zimbabwean Northern Ndebele review

The two user-facing language identifiers are `sn` and `nd`. `nr` is not a substitute. Web and native clients own independent catalogs; backend notifications and PDF/CSV headings have their own translated text. Stored event identifiers, quantities, currencies and units do not change with language selection. User notes are retained verbatim; no silent translation is performed.

## Review status

The current translations are draft software translations. **No fluent Shona or Zimbabwean Northern Ndebele reviewer has signed them off.** Translation-key tests establish that strings exist; they do not establish fluency, dialect suitability or comprehension under field conditions. Ordinary audio capture is supported without claiming speech recognition or text-to-speech for either language.

The glossary below records current catalog wording for review. It is a consistency aid, not an assertion that every term is the preferred local agricultural term.

| Concept | Shona draft | Northern Ndebele draft | Meaning to preserve |
| --- | --- | --- | --- |
| Farm | Purazi | Ipulazi | A farm with its own members and private records |
| Crop | Zvirimwa | Izilimo | Crop enterprise, distinct from animals |
| Irrigated maize | Chibage chiri kudiridzwa | Umumbu othelelwayo | Already-growing crop, with unknown facts left blank |
| Irrigation | Kudiridza | Ukuthelelela | Observed or planned water application |
| Measured rain | Mvura yakayerwa | Izulu elilinganisiweyo | Gauge/field measurement, never a forecast |
| Harvest | Kukohwa | Ukuvuna | Production, separate from sale and cash |
| Stock | Zviri mudura | Okusesitolo | Available physical inventory with units |
| Feed | Chikafu chezvipfuyo | Ukudla kwezifuyo | Feed issued to an animal project |
| Broilers | Huku dzenyama | Inkukhu zenyama | Meat-bird batch |
| Layers | Huku dzemazai | Inkukhu zamaqanda | Continuing egg-producing flock |
| Breeding chickens | Huku dzekuberekesa | Inkukhu zokuzalisa | Breeder flock and source eggs |
| Incubation/hatchery | Kuchechenyesa mazai | Ukuchamisela amaqanda | Eggs reserved for incubation and hatch outcomes |
| Rabbit breeding | Tsuro dzekuberekesa | Onogwaja bokuzalisa | Identified breeding animals and litters |
| Weaning | Kurumura | Ukulumula | Actual transition/transfer, not an assumed date |
| Fish | Hove | Inhlanzi | Species/configuration recorded separately |
| Sample size | Nhamba dzakayerwa | Inani elilinganisiweyo | Number actually sampled, not population count |
| Verified count | Hwakaverengwa | Kubaliwe | Count established by recorded verification |
| Estimate | Hwakafungidzirwa | Kulinganisiwe | Explicit uncertainty, never silently converted to fact |
| Unknown | Hazvizivikanwi | Akwaziwa | No measurement supplied; not zero |
| Recorded expense | Mari yakashandiswa | Imali esetshenzisiweyo | Recorded cost with currency and provenance |
| Sales revenue | Mari yekutengesa | Imali yokuthengisa | Amount owed from sale, not cash receipt |
| Farm time | Nguva yepurazi | Isikhathi sepulazi | Operational timezone, independent of traveling owner |
| Simulated | Zvemuedzo | Okwesilingiso | Fixture data, not physical hardware |
| Acknowledged | Ragamuchirwa | Samukelwe | Receipt/attention, distinct from completed action |
| Planned | Rakarongwa | Uhleliwe | Proposed/scheduled work, not an observation |
| Completed | Rapera | Uphelile | Work supported by completion evidence |
| Private photograph | Mufananidzo | Isithombe | Private unless deliberately published in a listing |
| Voice note | Izwi rakarekodhwa | Ilizwi elirekhodiweyo | Original audio attachment |

## Fluent review procedure

Review both clients and backend notifications/exports together. Prioritize permission prompts, destructive/correction confirmations, money/payment provenance, known/unknown/estimated counts, treatment restrictions, command acknowledgement versus physical confirmation, offline conflicts and camera simulation labels. Use farm workers and owners familiar with the local terminology; record the reviewer, language/dialect, date, catalog commit and changed keys.

Exercise each language at small-phone width, with large fonts, an on-screen keyboard and screen reader. Check whether instructions can be understood without reading implementation details. Confirm date/number/currency displays preserve the exact stored values and farm-local dates. Feed wording corrections back into both independently owned catalogs and this glossary. A sign-off remains pending until that review is actually completed.
