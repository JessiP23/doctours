# Booking references from end-to-end runs

Only references returned by Sabre CERT. Never hand-typed from memory.

| Date (UTC)           | Kind   | Reference | Provider order/PNR id                   | How produced                                 | Notes                                                                                                                        |
| -------------------- | ------ | --------- | --------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-07 19:21 UTC | flight | RPBASY    | (see tool_calls, conversation 26a5b207) | chat: search → Flight Check → Create Booking | First end-to-end flight booking through the conversation. Turkish Airlines round trip, patient details given in one message. |
| 2026-09-07 21:16 UTC | flight | RZWWNY    | RZWWNY                                  | scripts/sabre-smoke.ts e2e                   | $1259.83 LH, 7 nights derived                                                                                                |
| 2026-09-07 21:16 UTC | hotel  | RZIXCG    | RZIXCG                                  | scripts/sabre-smoke.ts e2e                   | Holiday Inn City Istanbul, Standard Room, $755.61                                                                            |
| 2026-09-07 21:22 UTC | flight | OCGMJQ    | OCGMJQ                                  | scripts/sabre-smoke.ts e2e                   | $1533.83 LH, 7 nights derived                                                                                                |
| 2026-09-07 21:22 UTC | hotel  | ROFKOX    | ROFKOX                                  | scripts/sabre-smoke.ts e2e                   | Holiday Inn City Istanbul, Standard Room, $755.61                                                                            |
| 2026-09-07 21:40 UTC | flight | RSZVBJ    | RSZVBJ                                  | chat conversation                            | Turkish non-stop, Oct 11 → 17, $1440.83. Patient asked for non-stop and named airline; preferences layer.                    |
| 2026-09-07 21:47 UTC | hotel  | RVXYRW    | RVXYRW                                  | chat conversation                            | Holiday Inn City Istanbul, Oct 12 → 17 (5 nights derived from RSZVBJ), flexible rate $708.79.                                |

## Verifying a reference

```
npm run sabre:smoke -- lookup RSZVBJ
```

Prints what Sabre holds: every segment with its status (`HK` = confirmed), the dates,
the traveller, and for a hotel the property, the nights and the vendor's own
confirmation number. The raw response is saved as a fixture.
