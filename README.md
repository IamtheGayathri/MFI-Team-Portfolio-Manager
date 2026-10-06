# MFI Project Tracker

A shared team website for the Microfinance (MFI) digital journeys POD. It holds the project tracker,
the minutes of meetings (MOM), and the reference material, and it handles reminders by email.

- **Project Tracker**: all workstreams grouped by brick (TOFU · MOFU · BOFU) and channel (App · Web · Loan Journey). Columns are status, SPOC, start and due dates, ticket and remarks. Anyone can change a status from the table, and every change is logged with who made it and when.
- **MOM & Meeting Notes**: a separate tab for minutes of important discussions. Each entry records the date, type, attendees, agenda, notes, decisions and action items (owner and due date). Any action item can be pushed into the tracker as a task.
- **Dashboard**: today's numbers, progress by brick, delayed and blocked items, items due in the next 3 days, what changed today, and overdue MOM actions.
- **Data Cuts** and **Overview & Scope**: the data cut list, the research brief and the scope, carried over from the reference workbook.
- **Download .xlsx** (top right): anyone can download the whole tracker at any time. The file uses the same layout and formatting as the reference workbook (`1 · Overview`, `2 · Project Tracker`, …) and adds two tabs: `3 · MOM & Meeting Notes` and `4 · MOM Action Items`.
- **Automated emails**
  - **Delay alerts**: sent when a task or MOM action item passes its due date without being completed, or when a task is marked **Blocked**. They go to every POD member plus the SPOC or owner. Each delay is emailed once and then stays on the daily summary until it is resolved. The check runs every morning (09:30 by default) and about a minute after anyone saves a change.
  - **Daily summary at 6 PM** (IST by default): totals, progress by brick, everything updated today (old → new value, and who changed it), delayed, blocked, due soon, overdue MOM actions and today's meetings. The day's Excel tracker is attached.

## Starting data (kept out of git)

This repository is public, so the team's real tracker content is **not** committed. To load it:

```bash
pip install openpyxl
python3 tools/import_reference.py MFI_Project_Tracker_PM_updated.xlsx seed/seed.json "Your Name"
```

This reads the tasks, data cuts, research brief, scope and SPOC names from the workbook and writes them to `seed/seed.json`, which is git-ignored. The app loads that file the first time it starts. If `seed/seed.json` does not exist, the app starts from a small generic sample (`seed/seed.example.json`).
After the first start, all live data is kept in `data/db.json`, which is also git-ignored.

## Run it

Requires Node.js 18 or later.

```bash
npm install
python3 tools/import_reference.py MFI_Project_Tracker_PM_updated.xlsx seed/seed.json "Your Name"
cp .env.example .env      # then fill in the SMTP settings (see below)
npm start                 # http://localhost:3000
```

The first time you open the site:

1. Pick your name under **You are** (top right). Every change you make is recorded against that name.
2. Go to **Team & Alerts** and add each person's email. Tick **POD member** for the 4 of you, so you all get every delay alert. Tick **Daily summary** for everyone who should get the 6 PM email.
3. In the Project Tracker, add **due dates** to tasks. Delay alerts depend on them: a task with no due date is never reported as late.
4. Click **Send today's summary now** to check that email works.

## Email set-up (SMTP)

If `SMTP_HOST` is not set, the app does not send anything. Each email is saved as an `.html` file in `data/outbox/` instead, so you can preview it. To send real emails, set these in `.env`:

| Provider | `SMTP_HOST` | `SMTP_PORT` | `SMTP_SECURE` | Notes |
|---|---|---|---|---|
| Office 365 / Outlook | `smtp.office365.com` | 587 | false | The mailbox needs SMTP AUTH enabled. Ask IT, or use their internal SMTP relay. |
| Gmail / Google Workspace | `smtp.gmail.com` | 465 | true | Use an [app password](https://support.google.com/accounts/answer/185833), not your normal password. |
| Company SMTP relay | from IT | from IT | — | Usually the best option inside a corporate network. |

Also set `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` and `APP_URL`. `APP_URL` is the site's address, used by the "Open the tracker" button in emails.

On the **Team & Alerts** tab you can change the summary time, choose every day, Mon–Sat or Mon–Fri, change the morning check time, or turn either email off.

## Hosting it for the team

The scheduled emails only go out while the server is running, so host the app somewhere that is always on:

- **Office server or VM**: run `npm start` under a process manager such as `pm2` or systemd, then share the URL with the team.
- **Docker**: run
  ```bash
  docker build -t mfi-tracker .
  docker run -d -p 3000:3000 --env-file .env -v mfi-data:/app/data --restart unless-stopped mfi-tracker
  ```
- **Render / Railway / Azure App Service**: deploy this repository and attach a **persistent disk**, setting `DATA_DIR` to the disk's path. Without a persistent disk, the data is lost on every redeploy.

Set `TEAM_PASSCODE` to put the site behind one shared passcode. All data is stored in `data/db.json`. Back that file up, or download the .xlsx regularly.

## Project layout

```
server.js              Express API + static site + scheduler start-up
src/store.js           JSON-file store (atomic writes, activity log)
src/tracker.js         Statuses, delay rules, SPOC → email matching, daily summary data
src/excel.js           .xlsx export in the reference workbook's layout
src/notifications.js   Delay alerts, 6 PM summary email, cron schedule
src/mailer.js          SMTP sending (or saving to data/outbox when SMTP is not set)
public/                The website (plain HTML/CSS/JS, no build step)
seed/seed.example.json Generic sample data (seed/seed.json with real data is git-ignored)
tools/import_reference.py  Builds seed/seed.json from the reference workbook
test/                  `npm test`
```
