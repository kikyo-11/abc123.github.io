const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 托管前端静态文件
app.use(express.static(path.join(__dirname, 'public')));

// ========== 房间数据 ==========
const rooms = new Map();

// 生成6位房间号
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

// 获取房间状态（剔除敏感信息）
function getRoomState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    
    // 构建玩家列表（只返回公开信息）
    const players = {};
    for (const [sid, data] of Object.entries(room.players)) {
        players[sid] = {
            name: data.name,
            roleId: data.roleId,
            isAI: data.isAI || false,
            isReady: data.isReady || false
        };
    }
    
    return {
        players,
        phase: room.phase || 0,
        cluesFound: room.cluesFound || [],
        votes: room.votes || {},
        started: room.started || false,
        secondFloorUnlocked: room.secondFloorUnlocked || false,
        investigationCount: room.investigationCount || 0,
        memoriesTriggered: room.memoriesTriggered || {},
        chatLog: (room.chatLog || []).slice(-100),
        roomId: roomId
    };
}

// ========== Socket 事件 ==========
io.on('connection', (socket) => {
    console.log('🔗 新连接:', socket.id);
    let currentRoom = null;

    // ----- 创建房间 -----
    socket.on('create-room', ({ playerName, roleId }) => {
        const roomId = generateRoomId();
        const room = {
            players: {},
            phase: 0,
            cluesFound: [],
            votes: {},
            started: false,
            secondFloorUnlocked: false,
            investigationCount: 0,
            memoriesTriggered: {},
            chatLog: [],
            creator: socket.id
        };
        rooms.set(roomId, room);
        
        // 加入房间
        room.players[socket.id] = {
            name: playerName,
            roleId: roleId || null,
            isAI: false,
            isReady: false
        };
        socket.join(roomId);
        socket.data.roomId = roomId;
        currentRoom = roomId;
        
        // 发送房间信息
        socket.emit('room-created', { roomId });
        io.to(roomId).emit('room-state', getRoomState(roomId));
        io.to(roomId).emit('chat-message', { 
            who: '系统', 
            text: `🕯️ ${playerName} 创建了房间「${roomId}」，等待其他玩家加入...` 
        });
        console.log(`📦 房间 ${roomId} 由 ${playerName} 创建`);
    });

    // ----- 加入房间 -----
    socket.on('join-room', ({ roomId, playerName, roleId }) => {
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('error-message', { text: '❌ 房间不存在，请检查房间号' });
            return;
        }
        
        // 检查房间是否已满（最多6人，含AI）
        const playerCount = Object.keys(room.players).length;
        if (playerCount >= 6) {
            socket.emit('error-message', { text: '❌ 房间已满' });
            return;
        }
        
        // 检查是否已在房间中
        if (room.players[socket.id]) {
            socket.emit('error-message', { text: '⚠️ 你已在该房间中' });
            return;
        }
        
        // 加入房间
        room.players[socket.id] = {
            name: playerName,
            roleId: roleId || null,
            isAI: false,
            isReady: false
        };
        socket.join(roomId);
        socket.data.roomId = roomId;
        currentRoom = roomId;
        
        io.to(roomId).emit('room-state', getRoomState(roomId));
        io.to(roomId).emit('chat-message', { 
            who: '系统', 
            text: `🕯️ ${playerName} 加入了房间` 
        });
        console.log(`➕ ${playerName} 加入房间 ${roomId}`);
    });

    // ----- 选择角色 -----
    socket.on('select-role', ({ roomId, roleId }) => {
        const room = rooms.get(roomId);
        if (!room || !room.players[socket.id]) return;
        
        // 检查该角色是否已被其他玩家选择
        let taken = false;
        for (const [sid, data] of Object.entries(room.players)) {
            if (sid !== socket.id && data.roleId === roleId) {
                taken = true;
                break;
            }
        }
        if (taken) {
            socket.emit('error-message', { text: '❌ 该角色已被选择' });
            return;
        }
        
        room.players[socket.id].roleId = roleId;
        room.players[socket.id].isReady = true;
        
        io.to(roomId).emit('room-state', getRoomState(roomId));
        io.to(roomId).emit('chat-message', { 
            who: '系统', 
            text: `🎭 ${room.players[socket.id].name} 选择了 ${roleId}` 
        });
    });

    // ----- 开始游戏（仅房主） -----
    socket.on('start-game', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        // 只有房主可以开始
        if (room.creator !== socket.id) {
            socket.emit('error-message', { text: '⚠️ 只有房主可以开始游戏' });
            return;
        }
        
        // 检查是否所有人都选择了角色
        let allReady = true;
        for (const [sid, data] of Object.entries(room.players)) {
            if (!data.roleId) {
                allReady = false;
                break;
            }
        }
        if (!allReady) {
            socket.emit('error-message', { text: '⚠️ 还有玩家未选择角色' });
            return;
        }
        
        room.started = true;
        room.phase = 0;
        
        // 添加AI补位（如果不足5人）
        const roles = ['柯太太', '柯少爷', '云晴', '零四', '雾晓'];
        const takenRoles = Object.values(room.players).map(p => p.roleId).filter(Boolean);
        const availableRoles = roles.filter(r => !takenRoles.includes(r));
        
        // 如果玩家少于5人，用AI补足
        const currentPlayerCount = Object.keys(room.players).length;
        const targetCount = Math.max(5, currentPlayerCount);
        for (let i = 0; i < targetCount - currentPlayerCount && availableRoles.length > 0; i++) {
            const aiId = 'ai_' + Date.now() + '_' + i;
            const role = availableRoles.pop();
            room.players[aiId] = {
                name: role + '(AI)',
                roleId: role,
                isAI: true,
                isReady: true
            };
        }
        
        io.to(roomId).emit('game-started');
        io.to(roomId).emit('room-state', getRoomState(roomId));
        io.to(roomId).emit('chat-message', { 
            who: '系统', 
            text: '🕯️ 游戏开始！请阅读剧本，然后开始寒暄。' 
        });
        console.log(`🎮 房间 ${roomId} 游戏开始`);
    });

    // ----- 聊天 -----
    socket.on('chat-message', ({ roomId, text }) => {
        const room = rooms.get(roomId);
        if (!room || !room.players[socket.id]) return;
        
        const name = room.players[socket.id].name;
        room.chatLog.push({ who: name, text, time: Date.now() });
        io.to(roomId).emit('chat-message', { who: name, text });
    });

    // ----- 调查线索 -----
    socket.on('investigate', ({ roomId, clueId, clueData }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        if (!room.cluesFound.includes(clueId)) {
            room.cluesFound.push(clueId);
            room.investigationCount = (room.investigationCount || 0) + 1;
            
            // 检查是否解锁二层
            if (['c9', 'c11', 'c12'].includes(clueId)) {
                room.secondFloorUnlocked = true;
                io.to(roomId).emit('chat-message', { 
                    who: '系统', 
                    text: '🏚️ 发现了通往二层的线索！可以调查二层了。' 
                });
            }
            
            const name = room.players[socket.id]?.name || '玩家';
            io.to(roomId).emit('chat-message', { 
                who: '系统', 
                text: `🔍 ${name} 调查了「${clueData?.title || clueId}」` 
            });
            io.to(roomId).emit('clue-found', { clueId, clueData });
            io.to(roomId).emit('room-state', getRoomState(roomId));
        }
    });

    // ----- 触发记忆 -----
    socket.on('trigger-memory', ({ roomId, memoryKey, memoryText }) => {
        const room = rooms.get(roomId);
        if (!room || !room.players[socket.id]) return;
        
        const roleId = room.players[socket.id].roleId;
        if (!room.memoriesTriggered[roleId]) room.memoriesTriggered[roleId] = [];
        
        if (!room.memoriesTriggered[roleId].includes(memoryKey)) {
            room.memoriesTriggered[roleId].push(memoryKey);
            io.to(roomId).emit('memory-triggered', { 
                roleId, 
                memoryKey, 
                memoryText,
                playerId: socket.id 
            });
            io.to(roomId).emit('room-state', getRoomState(roomId));
        }
    });

    // ----- 投票 -----
    socket.on('vote', ({ roomId, targetRoleId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        room.votes[socket.id] = targetRoleId;
        io.to(roomId).emit('vote-update', room.votes);
        io.to(roomId).emit('room-state', getRoomState(roomId));
    });

    // ----- 推进阶段 -----
    socket.on('next-phase', (roomId) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const phases = ['寒暄', '二层', '真凶', '投票'];
        if (room.phase < phases.length - 1) {
            room.phase = (room.phase || 0) + 1;
            io.to(roomId).emit('phase-change', room.phase);
            io.to(roomId).emit('chat-message', { 
                who: '系统', 
                text: `📌 进入第 ${room.phase + 1} 幕：${phases[room.phase]}` 
            });
            io.to(roomId).emit('room-state', getRoomState(roomId));
        }
    });

    // ----- 请求房间状态 -----
    socket.on('request-state', (roomId) => {
        const room = rooms.get(roomId);
        if (room) {
            socket.emit('room-state', getRoomState(roomId));
        }
    });

    // ----- 断开连接 -----
    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if (roomId && rooms.has(roomId)) {
            const room = rooms.get(roomId);
            if (room.players[socket.id]) {
                const name = room.players[socket.id].name;
                delete room.players[socket.id];
                
                // 如果房间空了，删除房间
                if (Object.keys(room.players).length === 0) {
                    rooms.delete(roomId);
                    console.log(`🗑️ 房间 ${roomId} 已删除（空）`);
                } else {
                    io.to(roomId).emit('chat-message', { 
                        who: '系统', 
                        text: `👋 ${name} 离开了房间` 
                    });
                    io.to(roomId).emit('room-state', getRoomState(roomId));
                }
            }
        }
        console.log('🔌 断开连接:', socket.id);
    });
});

// ========== 健康检查 ==========
app.get('/health', (req, res) => {
    res.json({ status: 'ok', rooms: rooms.size });
});

// ========== 启动服务器 ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
    console.log(`📡 健康检查: http://localhost:${PORT}/health`);
});