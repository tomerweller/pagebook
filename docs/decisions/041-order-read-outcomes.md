# 041: Order read outcomes

Date: 2026-09-09. Order reads return found, absent, archived, or unavailable.
A remembered nonce is forgotten only on authoritative absence: getLedgerEntries
succeeded for that key's chunk and the ledger had no matching entry.

A failed RPC call or a failed view simulation keeps the nonce in storage. If
the previous refresh had a row for that nonce, the client keeps the row and
sets unavailable so the pane can show it as last known state.

Discovery reads order entries in batches of 200 keys and runs at most four
view simulations at once. The remembered nonce set is the only cap. Display
pagination of the orders list is a separate concern.
