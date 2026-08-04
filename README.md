# Pair_Reviews_Bot

# Element Pair Review Bot

Automated daily pair messages to your Element room at 11:00 AM.

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
CRON_SCHEDULE=0 11 * * *
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

## How pairs work

- **Developers** — 2-person pairs rotate daily  
- **QA** — fixed: Habiba + Aqeel + Adil  
- **Lead** — rotates daily across the full team  
- **Schedule** — every day at 11:00 AM (Asia/Karachi)  
- **Preview** — before 11 AM show today; after 11 AM show tomorrow  

```
Pairs Today

Uzair + Mohsin
Saad + Farhan
Faz + Hamza
Habiba + Aqeel + Adil

Uzair will make sure all above today
```
