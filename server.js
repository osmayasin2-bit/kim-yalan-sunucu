const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT }, () => {
    console.log(`[KİM YALAN SÖYLÜYOR?] WebSocket Relay Sunucusu Port ${PORT} üzerinde hazır!`);
});

// rooms: room_code -> { is_public, room_name, host_id, players: { id: { ws, name, color, item, ready, is_host } }, max_players: 6 }
const rooms = new Map();
let nextPlayerId = 1;

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function broadcastToRoom(roomCode, data) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const msg = JSON.stringify(data);
    for (const p of Object.values(room.players)) {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(msg);
        }
    }
}

function sendRoomUpdate(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    const playersData = {};
    for (const [pid, p] of Object.entries(room.players)) {
        playersData[pid] = {
            id: pid,
            name: p.name,
            color: p.color,
            item: p.item,
            ready: p.ready,
            is_host: p.is_host
        };
    }

    broadcastToRoom(roomCode, {
        type: 'room_update',
        room_code: roomCode,
        room_name: room.room_name,
        is_public: room.is_public,
        host_id: room.host_id,
        players: playersData
    });
}

wss.on('connection', (ws) => {
    const playerId = 'p_' + (nextPlayerId++);
    let currentRoomCode = null;

    ws.on('message', (messageRaw) => {
        try {
            const data = JSON.parse(messageRaw);
            const action = data.type;

            if (action === 'create_room') {
                let code = (data.room_code || generateRoomCode()).toUpperCase().trim();
                if (rooms.has(code)) {
                    code = generateRoomCode();
                }

                const pInfo = data.player || {};
                const playerObj = {
                    ws: ws,
                    name: pInfo.name || 'Oyuncu',
                    color: pInfo.color || '#FF4757',
                    item: pInfo.item || '👑',
                    ready: true,
                    is_host: true
                };

                const room = {
                    room_code: code,
                    is_public: !!data.is_public,
                    room_name: data.room_name || (playerObj.name + "'nin Odası"),
                    host_id: playerId,
                    max_players: 6,
                    players: { [playerId]: playerObj }
                };

                rooms.set(code, room);
                currentRoomCode = code;

                ws.send(JSON.stringify({
                    type: 'room_created',
                    room_code: code,
                    player_id: playerId,
                    is_host: true
                }));

                sendRoomUpdate(code);
                console.log(`[ODA OLUŞTURULDU] Kod: ${code} | Sahip: ${playerObj.name} | Açık: ${room.is_public}`);
            }
            else if (action === 'join_room') {
                const code = (data.room_code || '').toUpperCase().trim();
                const room = rooms.get(code);

                if (!room) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Oda bulunamadı! Lütfen kodu kontrol edin.'
                    }));
                    return;
                }

                if (Object.keys(room.players).length >= room.max_players) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Oda dolu! (Maksimum 6 oyuncu)'
                    }));
                    return;
                }

                const pInfo = data.player || {};
                const playerObj = {
                    ws: ws,
                    name: pInfo.name || 'Misafir',
                    color: pInfo.color || '#2ED573',
                    item: pInfo.item || '🕶️',
                    ready: false,
                    is_host: false
                };

                room.players[playerId] = playerObj;
                currentRoomCode = code;

                ws.send(JSON.stringify({
                    type: 'room_joined',
                    room_code: code,
                    player_id: playerId,
                    is_host: false
                }));

                sendRoomUpdate(code);

                broadcastToRoom(code, {
                    type: 'chat_message',
                    sender_name: 'SİSTEM',
                    sender_color: '#00E676',
                    message: `${playerObj.name} odaya katıldı!`,
                    is_system: true
                });

                console.log(`[KATILIM] ${playerObj.name} -> Oda ${code}`);
            }
            else if (action === 'list_rooms') {
                const publicList = [];
                for (const [code, r] of rooms.entries()) {
                    if (r.is_public) {
                        const count = Object.keys(r.players).length;
                        const host = r.players[r.host_id];
                        publicList.push({
                            room_code: code,
                            room_name: r.room_name,
                            count: count,
                            max: r.max_players,
                            host_name: host ? host.name : 'Host'
                        });
                    }
                }
                ws.send(JSON.stringify({
                    type: 'public_rooms_list',
                    rooms: publicList
                }));
            }
            else if (action === 'toggle_ready') {
                if (!currentRoomCode || !rooms.has(currentRoomCode)) return;
                const room = rooms.get(currentRoomCode);
                const p = room.players[playerId];
                if (p) {
                    p.ready = !p.ready;
                    sendRoomUpdate(currentRoomCode);
                }
            }
            else if (action === 'kick_player') {
                if (!currentRoomCode || !rooms.has(currentRoomCode)) return;
                const room = rooms.get(currentRoomCode);
                if (room.host_id !== playerId) return; // Sadece host atabilir

                const targetId = data.target_id;
                const target = room.players[targetId];
                if (target && targetId !== room.host_id) {
                    target.ws.send(JSON.stringify({
                        type: 'kicked',
                        message: 'Oda sahibi seni odadan çıkardı.'
                    }));
                    delete room.players[targetId];
                    sendRoomUpdate(currentRoomCode);

                    broadcastToRoom(currentRoomCode, {
                        type: 'chat_message',
                        sender_name: 'SİSTEM',
                        sender_color: '#FF4757',
                        message: `${target.name} odadan çıkarıldı.`,
                        is_system: true
                    });
                }
            }
            else if (action === 'chat') {
                if (!currentRoomCode || !rooms.has(currentRoomCode)) return;
                const room = rooms.get(currentRoomCode);
                const p = room.players[playerId];
                if (p && data.message) {
                    broadcastToRoom(currentRoomCode, {
                        type: 'chat_message',
                        sender_name: p.name,
                        sender_color: p.color,
                        message: String(data.message).slice(0, 150),
                        is_system: false
                    });
                }
            }
            else if (action === 'start_game') {
                if (!currentRoomCode || !rooms.has(currentRoomCode)) return;
                const room = rooms.get(currentRoomCode);
                if (room.host_id !== playerId) return; // Sadece host başlatabilir

                broadcastToRoom(currentRoomCode, {
                    type: 'game_started'
                });
                console.log(`[OYUN BAŞLADI] Oda: ${currentRoomCode}`);
            }
            else if (action === 'leave_room') {
                handleLeave();
            }
        } catch (err) {
            console.error('Hata:', err);
        }
    });

    function handleLeave() {
        if (!currentRoomCode || !rooms.has(currentRoomCode)) return;
        const room = rooms.get(currentRoomCode);
        const p = room.players[playerId];
        delete room.players[playerId];

        const remaining = Object.keys(room.players);
        if (remaining.length === 0) {
            rooms.delete(currentRoomCode);
            console.log(`[ODA KAPANDI] ${currentRoomCode} boşaldı.`);
        } else {
            if (p) {
                broadcastToRoom(currentRoomCode, {
                    type: 'chat_message',
                    sender_name: 'SİSTEM',
                    sender_color: '#FFA502',
                    message: `${p.name} ayrıldı.`,
                    is_system: true
                });
            }
            // Host ayrıldıysa sonraki oyuncuyu host yap
            if (room.host_id === playerId) {
                room.host_id = remaining[0];
                room.players[remaining[0]].is_host = true;
                room.players[remaining[0]].ready = true;
            }
            sendRoomUpdate(currentRoomCode);
        }
        currentRoomCode = null;
    }

    ws.on('close', () => {
        handleLeave();
    });

    ws.on('error', () => {
        handleLeave();
    });
});
