import sqlite3, json, os
db = os.path.expanduser("~/.remote-copilot-mcp/memory.db")
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
cur = con.cursor()

# Total notes / how many have links
total = cur.execute("SELECT COUNT(*) FROM semantic_notes").fetchone()[0]
active = cur.execute("SELECT COUNT(*) FROM semantic_notes WHERE valid_to IS NULL").fetchone()[0]
with_links = cur.execute("SELECT COUNT(*) FROM semantic_notes WHERE linked_notes IS NOT NULL AND linked_notes != '' AND linked_notes != '[]'").fetchone()[0]
print(f"TOTAL notes: {total}  ACTIVE(valid_to NULL): {active}  WITH linked_notes: {with_links}")

# Build id->note map for dangling check + validity
rows = cur.execute("SELECT note_id, type, content, linked_notes, link_reasons, valid_to, quality_score FROM semantic_notes").fetchall()
byid = {r['note_id']: r for r in rows}

total_links = 0
dangling = 0           # link target id not in table at all
to_expired = 0         # link target exists but is expired (valid_to not null)
empty_reason = 0
reasons_sample = []
dangling_sample = []
expired_sample = []

for r in rows:
    ln = r['linked_notes']
    if not ln or ln in ('[]',''): continue
    try:
        ids = json.loads(ln)
    except Exception:
        continue
    try:
        reasons = json.loads(r['link_reasons']) if r['link_reasons'] else {}
    except Exception:
        reasons = {}
    for tid in ids:
        total_links += 1
        reason = reasons.get(tid)
        if not reason or not str(reason).strip():
            empty_reason += 1
        target = byid.get(tid)
        if target is None:
            dangling += 1
            if len(dangling_sample) < 8:
                dangling_sample.append((r['note_id'], tid, reason))
        elif target['valid_to'] is not None:
            to_expired += 1
            if len(expired_sample) < 8:
                expired_sample.append((r['note_id'], tid, reason))
        # collect reason samples from active source notes
        if r['valid_to'] is None and reason and len(reasons_sample) < 25:
            src = (r['content'] or '')[:90].replace('\n',' ')
            tgt = (target['content'][:90].replace('\n',' ')) if target else '<MISSING>'
            reasons_sample.append((reason, src, tgt))

print(f"\nTOTAL link edges: {total_links}")
print(f"  dangling (target id missing): {dangling}")
print(f"  point to EXPIRED note (valid_to set): {to_expired}")
print(f"  empty/blank reason: {empty_reason}")

print("\n--- DANGLING SAMPLES (source -> missing target : reason) ---")
for s,t,rs in dangling_sample:
    print(f"  {s} -> {t} : {rs}")

print("\n--- LINKS TO EXPIRED NOTES (source -> expired target : reason) ---")
for s,t,rs in expired_sample:
    print(f"  {s} -> {t} : {rs}")

print("\n--- REASON QUALITY SAMPLE (reason || src-content || tgt-content) ---")
for reason, src, tgt in reasons_sample:
    print(f"\n  REASON: {reason}")
    print(f"    SRC: {src}")
    print(f"    TGT: {tgt}")

con.close()
