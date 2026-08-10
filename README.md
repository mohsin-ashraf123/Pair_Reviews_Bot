# Pair_Reviews_Bot

# Element Pair Review Bot

Automated daily pair messages to your Element room, plus private follow-ups when a pair review is missing.

## Setup

### server/.env

```env
PORT=5001
MONGO_URI=your_mongodb_connection_string

MATRIX_HOMESERVER_URL=https://matrix-client.matrix.org
MATRIX_ROOM_ID=!yourRoomId:matrix.org

# Required for encrypted rooms (E2EE)
MATRIX_USER=@bot_dtrader:matrix.org
MATRIX_PASSWORD=chat_bot_account_password

# Team
DEVELOPERS=Uzair,Mohsin,Saad,Farhan,Faz,Hamza
QA_TEAM=Habiba,Aqeel,Adil

CRON_TIMEZONE=Asia/Karachi
CRON_SCHEDULE=30 11 * * 1-5
MISSING_REVIEW_PROMPT_CRON_SCHEDULE=50 10 * * 1-5
MISSED_REVIEW_CRON_SCHEDULE=20 11 * * 1-5
REMINDER_CRON_SCHEDULE=50 18 * * 1-5

# Personal bot room per member (missing-review follow-ups)
MEMBER_ROOM_MAP=Mohsin=!roomId:matrix.org,Saad=!roomId2:matrix.org
```

### Why password is required for “Not encrypted”

Your Element room has **encryption on**.  
Element Web/App **Access Token** is already tied to a crypto device. Reusing that token for the bot conflicts with keys → messages show **Not encrypted**, or the server crashes.

**Fix:** put Chat Bot account **username + password** in `.env`.  
Server logs in as a **new dedicated device**, saves session under `server/data/matrix/`, and sends **proper E2EE** messages.

Element **Recovery Key** is only for recovering an Element app session. The bot **cannot** use it instead of password login.

Dashboard also shows **Room name**.

## Run

```bash
# Terminal 1
cd server && npm install && npm run dev

# Terminal 2
cd client && npm install && npm run dev
```

- Frontend: http://localhost:5173 (or 5174)
- Backend: http://localhost:5001

## Deploy on Railway

1. Connect repo: `mohsin-ashraf123/Pair_Reviews_Bot`
2. **Root Directory** leave as `/` (repo root — `package.json` is here)
3. Railway will run: `npm run build` → `npm start`
4. Add **Variables** in Railway (from `server/.env.example`):
   - `MONGO_URI`, `MATRIX_*`, `DEVELOPERS`, `QA_TEAM`, `CRON_*`, `MEMBER_MATRIX_MAP`, `MEMBER_ROOM_MAP`
   - Do **not** set `PORT` — Railway sets it automatically
5. Open your Railway URL — dashboard + API run on the same domain

> Matrix E2EE session is stored in `server/data/` locally. On Railway, set `MATRIX_USER` + `MATRIX_PASSWORD` so the bot can log in on each deploy (or attach a volume for `server/data`).

## How pairs work

- **Developers** — 2-person pairs rotate daily  
- **QA** — fixed: Habiba + Aqeel + Adil  
- **Lead** — rotates daily across the full team  
- **Preview** — before the send time show today; after it show tomorrow  

```
Pairs Today

Uzair + Mohsin
Saad + Farhan
Faz + Hamza
Habiba + Aqeel + Adil

Uzair will make sure all above today
```

## Daily schedule (Mon–Fri, Asia/Karachi)

| Time | What happens | Where |
|------|--------------|-------|
| 10:50 AM | Private follow-up to each member of yesterday's pairs that missed a review | Member's own room |
| 11:20 AM | Missed review notice, including each member's answer | Main room |
| 11:30 AM | Today's pairs | Main room |
| 6:50 PM | Reminder for pairs that still have not submitted | Main room |

> If Railway still has old values like `MISSED_REVIEW_CRON_SCHEDULE=50 10` or
> `CRON_SCHEDULE=0 11`, the bot now **corrects the order automatically** so
> personal DMs always go out before the room summary, and today's pairs wait
> until 11:30 AM.

## Missing review follow-ups

Each member has a personal room (`MEMBER_ROOM_MAP`). When their pair review is
missing, the bot asks them privately why and their reply drives attendance.

Developer pair (5 options):

```
🔔 Missing Review — August 5, 2026

Hi Mohsin,

No review was received for Mohsin + Saad.

Reply with one letter only:

A — Saad was absent
B — I was absent
C — Both of us were absent
D — I was on half day leave
E — Forgot to send the review (August 5, 2026)

Example: A
```

The QA trio gets 6 options (one per partner, self, all, half day, forgot).
Replying with two letters (`A B`) marks both partners absent.

How answers map to **Performance**:

| Answer | Result |
|--------|--------|
| Someone was absent | Those members marked **Absent** |
| Half day leave | Member marked **Half day** — kept out of the rate |
| Forgot to send review | Whole pair marked **Forgot** — still counts as attended |
| Partner absent | The member who replied is marked **Excused** |

The 11:20 AM room notice shows the outcome in brackets:

```
Yesterday (August 6, 2026) the following pairs did not submit their review:

Hamza + Farhan (Farhan absent)
Mohsin + Saad (they forgot to send review)
Uzair + Faz (Faz half day leave)
Habiba + Aqeel + Adil (no response yet)
```

The **Member Rooms** page in the dashboard shows every room, the message that
will go out, and each reply as it arrives.
