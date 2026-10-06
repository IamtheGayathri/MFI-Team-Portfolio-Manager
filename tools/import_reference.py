"""Build seed/seed.json (the tracker's starting data) from the reference workbook.

Usage:  python3 tools/import_reference.py MFI_Project_Tracker_PM_updated.xlsx seed/seed.json "Your Name"
        (the optional third argument marks that SPOC as the PM: POD member + daily summary)
Needs:  pip install openpyxl
Run it once before the first `npm start`; afterwards the live data lives in data/db.json.
seed/seed.json is git-ignored because it contains internal business data.
"""
import sys, json, openpyxl, re
wb = openpyxl.load_workbook(sys.argv[1])
ov = wb["1 · Overview"]
overview = {
  "title": ov["B2"].value.strip(), "subtitle": ov["B3"].value.strip(),
  "channels": [ov[c+"5"].value for c in "CDE"],
  "bricks": [{"brick": ov[f"B{r}"].value.split("\n")[0], "label": ov[f"B{r}"].value.split("\n")[1],
              "cells": [[l.lstrip("• ").strip() for l in ov[f"{c}{r}"].value.split("\n")] for c in "CDE"]} for r in (6,7,8)],
  "targetsTitle": ov["B10"].value,
  "targets": [[ov[f"{c}{r}"].value for c in "BCDE"] for r in (11,12,13)],
}
pt = wb["2 · Project Tracker"]
tasks=[]
for r in range(6, pt.max_row+1):
    if pt[f"B{r}"].value is None: continue
    g=lambda c:(pt[f"{c}{r}"].value or "")
    tasks.append({"id":int(g("B")),"brick":g("C"),"channel":g("D"),"workstream":g("E"),"task":g("F"),
      "status":g("G") or "TBD","spoc":(g("H") or "").strip(),"outcome":g("I"),"ticket":str(g("J")),
      "startDate":"","dueDate":"","remarks":""})
def kv(ws, start, stop):
    out=[]; cur=None
    for r in range(start, stop+1):
        a=ws[f"A{r}"].value; c=ws[f"C{r}"].value
        if a and not c and (str(a).isupper()):
            cur={"heading":a.strip(),"items":[]}; out.append(cur); continue
        if a and c: cur["items"].append({"label":a.strip(),"text":c.strip()})
        elif a and cur is not None and not cur["items"] and str(a).strip(): cur["intro"]=a.strip()
    return out
rb=wb["Research Brief"]; sc=wb["Scope"]
research=kv(rb,1,rb.max_row); scope=kv(sc,1,sc.max_row)
dc=wb["Data Cuts required"]
steps=[{"label":dc[f"A{r}"].value,"text":dc[f"C{r}"].value} for r in range(2,17,2)]
cuts=[]
for i,r in enumerate(range(21, dc.max_row+1)):
    if not dc[f"A{r}"].value: continue
    v=[dc[f"{c}{r}"].value or "" for c in "ABCDEF"]
    cuts.append({"id":i+1,"cut":v[0],"who":v[1],"fields":v[2],"output":v[3],"period":v[4],"status":v[5] or "TBD","owner":"","dueDate":"","remarks":""})
names=set()
for t in tasks:
    for n in re.split(r"\s*/\s*", t["spoc"]):
        if n: names.add(n.strip())
PM = sys.argv[3] if len(sys.argv) > 3 else ""
names.add(PM) if PM else None
team=[{"id":i+1,"name":n,"role":"Product Manager" if n==PM else "","email":"","pod":n==PM,"dailySummary":n==PM} for i,n in enumerate(sorted(names, key=lambda x:(x!=PM,x)))]
json.dump({"overview":overview,"tasks":tasks,"dataPrepSteps":steps,"dataCuts":cuts,"research":research,"scope":scope,"team":team,"meetings":[]},
          open(sys.argv[2],"w"),ensure_ascii=False,indent=2)
print(len(tasks),len(cuts),[s["heading"] for s in research],[s["heading"] for s in scope],[t["name"] for t in team])
