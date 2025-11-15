// server.js (Полный код с изменениями)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
// Подключаем НОВУЮ, ИСПРАВЛЕННУЮ логику
const { GameServerLogic } = require('./GameServerLogic'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Обслуживаем статические файлы из КОРНЕВОЙ директории
app.use(express.static(__dirname)); 

// Явный маршрут для главной страницы
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Инициализация серверной логики игры
const gameServer = new GameServerLogic(io);

// Обработка подключений Socket.io
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    
    // Авторизация
    socket.on('auth_request', () => {
        gameServer.handleAuth(socket);
    });

    // Действия в лобби
    socket.on('join_table', (data) => {
        gameServer.joinTable(socket, data.tableId, data.wantsBots);
    });
    
    socket.on('leave_table', () => {
        gameServer.leaveTable(socket);
    });
    
    socket.on('create_table', (data) => {
        gameServer.createTable(socket, data);
    });
    
    // OLD: Запуск игры (удален, заменен на start_game_command)
    /*
    socket.on('start_game', (data) => {
        gameServer.startGame(socket, data.tableId);
    });
    */

    // Блэкджек действия
    socket.on('place_bet', (data) => {
        gameServer.placeBet(socket, data.tableId, data.amount);
    });
    
    // НОВОЕ: Обработчик для явного запуска игры
    socket.on('start_game_command', (data) => {
        gameServer.startGameCommand(socket, data.tableId);
    });

    socket.on('hit', (data) => {
        gameServer.hit(socket, data.tableId);
    });

    socket.on('stand', (data) => {
        gameServer.stand(socket, data.tableId);
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