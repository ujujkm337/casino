// server.js (Полный исправленный код)
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

    // Действия в лобби
    socket.on('join_table', (data) => {
        // Добавлена передача пароля
        gameServer.joinTable(socket, data.tableId, data.wantsBots, data.password);
    });
    
    socket.on('leave_table', () => {
        gameServer.leaveTable(socket);
    });
    
    socket.on('create_table', (data) => {
        gameServer.createTable(socket, data);
    });
    
    // НОВОЕ: Быстрая игра
    socket.on('quick_play', (data) => {
        gameServer.handleQuickPlay(socket, data.gameType);
    });

    // Блэкджек действия
    socket.on('place_bet', (data) => {
        gameServer.placeBet(socket, data.tableId, data.amount);
    });
    
    socket.on('start_game_command', (data) => {
        gameServer.startGameCommand(socket, data.tableId);
    });

    socket.on('hit', (data) => {
        gameServer.hit(socket, data.tableId);
    });

    socket.on('stand', (data) => {
        gameServer.stand(socket, data.tableId);
    });
    
    // Покер действия (заглушки)
    socket.on('fold', () => {
        gameServer.fold(socket);
    });
    
    socket.on('call_check', () => {
        gameServer.call_check(socket);
    });
    
    socket.on('raise', () => {
        gameServer.raise(socket);
    });
    
    socket.on('disconnect', () => {
        gameServer.handleDisconnect(socket);
    });
});

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});