// server.js (Полный код с ИЗМЕНЕНИЯМИ)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GameServerLogic } = require('./GameServerLogic'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

app.use(express.static(__dirname)); 

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const gameServer = new GameServerLogic(io);

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    socket.on('auth_request', () => {
        gameServer.handleAuth(socket);
    });

    socket.on('join_table', (data) => {
        gameServer.joinTable(socket, data.tableId, data.wantsBots, data.password);
    });
    
    socket.on('leave_table', () => {
        gameServer.leaveTable(socket);
    });
    
    socket.on('create_table', (data) => {
        gameServer.createTable(socket, data);
    });
    
    socket.on('quick_play', (data) => {
        gameServer.handleQuickPlay(socket, data.gameType);
    });

    // Блэкджек действия
    socket.on('place_bet', (data) => {
        gameServer.placeBet(socket, data.tableId, data.amount);
    });
    
    // (Используется и Блэкджеком, и Покером)
    socket.on('start_game_command', (data) => {
        gameServer.startGameCommand(socket, data.tableId);
    });

    socket.on('hit', (data) => {
        gameServer.hit(socket, data.tableId);
    });

    socket.on('stand', (data) => {
        gameServer.stand(socket, data.tableId);
    });
    
    // НОВОЕ: Покер действия (вызов заглушек)
    socket.on('fold', () => {
        gameServer.fold(socket);
    });
    
    socket.on('call_check', () => {
        gameServer.callCheck(socket);
    });

    socket.on('raise', (data) => {
        gameServer.raise(socket, data.amount);
    });


    // Обработка отключения
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        gameServer.handleDisconnect(socket);
    });
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});