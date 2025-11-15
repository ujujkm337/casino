// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GameServerLogic } = require('./GameServerLogic'); // Логика игры вынесена в отдельный файл

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Обслуживаем статические файлы из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация серверной логики игры
const gameServer = new GameServerLogic(io);

// Обработка подключений Socket.io
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    // Авторизация и получение списка столов
    socket.on('auth_request', () => {
        gameServer.handleAuth(socket);
    });

    // Действия игрока
    socket.on('join_table', (data) => {
        gameServer.joinTable(socket, data.tableId, data.gameType, data.wantsBots);
    });
    
    socket.on('leave_table', () => {
        gameServer.leaveTable(socket);
    });

    // Блэкджек действия
    socket.on('place_bet', (data) => {
        gameServer.placeBet(socket, data.tableId, data.amount);
    });

    socket.on('hit', (data) => {
        gameServer.hit(socket, data.tableId);
    });

    socket.on('stand', (data) => {
        gameServer.stand(socket, data.tableId);
    });

    // Покер действия (упрощенные)
    socket.on('call_check', (data) => {
        gameServer.pokerAction(socket, data.tableId, 'call');
    });

    socket.on('raise', (data) => {
        gameServer.pokerAction(socket, data.tableId, 'raise', data.amount);
    });

    socket.on('fold', (data) => {
        gameServer.pokerAction(socket, data.tableId, 'fold');
    });
    
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        gameServer.handleDisconnect(socket);
    });
});

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});