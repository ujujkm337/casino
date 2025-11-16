// GameServerLogic.js (Полный код)

const { v4: uuidv4 } = require('uuid'); 

// --- УТИЛИТЫ КАРТ ---
const cardRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const cardSuits = ['C', 'D', 'H', 'S']; // Clubs, Diamonds, Hearts, Spades

/**
 * Расчет очков в Блэкджеке.
 */
function calculateScore(hand) {
    let score = 0;
    let aces = 0;
    hand.forEach(cardStr => {
        const rank = cardStr.slice(0, -1);
        if (rank === 'A') {
            aces++;
            score += 11;
        } else if (['K', 'Q', 'J', 'T'].includes(rank)) {
            score += 10;
        } else {
            score += parseInt(rank);
        }
    });
    // Обработка Тузов как 1
    while (score > 21 && aces > 0) {
        score -= 10;
        aces--;
    }
    return score;
}

class Deck {
    constructor() {
        this.cards = [];
        this.reset();
    }
    reset() {
        this.cards = [];
        for (const suit of cardSuits) {
            for (const rank of cardRanks) {
                this.cards.push(rank + suit);
            }
        }
        this.shuffle();
    }
    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }
    draw() {
        if (this.cards.length === 0) {
            this.reset();
        }
        return this.cards.pop();
    }
}


class GameServerLogic {
    constructor(io) {
        this.io = io;
        this.players = {}; // Состояние игроков (id, balance, username, currentTableId)
        this.tables = {
            'T1': { id: 'T1', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 2, minBet: 10, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] },
            'T2': { id: 'T2', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 6, minBet: 20, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] },
            'P1': { id: 'P1', gameType: 'Poker', currentPlayers: 0, maxPlayers: 4, minBet: 50, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] }
        };
        this.startTableLoop(); // Запуск цикла обновления
    }
    
    // --- УПРАВЛЕНИЕ ЛОББИ И ПОЛЬЗОВАТЕЛЯМИ ---
    
    handleAuth(socket) {
        let player = this.players[socket.id];
        if (!player) {
            // Создание нового пользователя
            player = {
                id: socket.id,
                username: `User_${Math.floor(Math.random() * 10000)}`,
                balance: 10000,
                currentTableId: null
            };
            this.players[socket.id] = player;
        }
        socket.emit('auth_success', { id: player.id, username: player.username, balance: player.balance, tables: this.broadcastTableList() });
        this.broadcastTableList();
    }

    broadcastTableList() {
        const publicTables = Object.values(this.tables).map(table => ({
            id: table.id,
            gameType: table.gameType,
            currentPlayers: table.players.length,
            maxPlayers: table.maxPlayers,
            minBet: table.minBet,
            isPrivate: table.isPrivate,
            state: table.state
        }));
        this.io.emit('table_list', publicTables);
        return publicTables;
    }

    createTable(socket, data) {
        const player = this.players[socket.id];
        if (player.currentTableId) {
            socket.emit('error_message', 'Вы уже за столом.');
            return;
        }

        const newTableId = `T${uuidv4().slice(0, 4)}`;
        const newTable = {
            id: newTableId,
            gameType: data.gameType,
            currentPlayers: 0,
            maxPlayers: data.maxPlayers,
            minBet: data.minBet,
            isPrivate: data.isPrivate,
            password: data.password || null,
            state: 'WAITING_FOR_PLAYERS',
            players: [],
            deck: new Deck(),
            dealerHand: []
        };
        this.tables[newTableId] = newTable;
        this.joinTable(socket, newTableId, false); // Владелец сразу присоединяется
    }

    joinTable(socket, tableId, wantsBots) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (!table || table.players.length >= table.maxPlayers) {
            socket.emit('error_message', 'Стол недоступен или полон.');
            return;
        }
        
        // Покидаем предыдущий стол, если он есть
        if (player.currentTableId) {
             this.leaveTable(socket);
        }

        // 1. Обновление состояния сервера
        // Установка активным - всегда при присоединении, для возможности делать ставку
        table.players.push({ id: player.id, username: player.username, bet: 0, hand: [], active: true }); 
        player.currentTableId = tableId;
        table.currentPlayers = table.players.length;

        // 2. Установка статуса стола
        if (table.gameType === 'Blackjack' && (table.state === 'WAITING_FOR_PLAYERS' || table.state === 'RESULTS')) {
             table.state = 'WAITING_FOR_BETS';
        }
        
        // 3. Сокеты
        socket.join(tableId);
        socket.emit('table_joined', { tableId: tableId, gameType: table.gameType, minBet: table.minBet });

        // 4. Уведомление других игроков и лобби
        this.sendTableState(table);
        this.broadcastTableList();
    }

    /**
     * ИСПРАВЛЕНИЕ: Добавление сброса ставки игрока при выходе, чтобы ставка не "зависала".
     */
    leaveTable(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;

        const tableId = player.currentTableId;
        const table = this.tables[tableId];
        
        // Находим игрока, чтобы вернуть ему ставку, если она была
        const exitingPlayer = table.players.find(p => p.id === player.id);
        if (exitingPlayer && exitingPlayer.bet > 0) {
            player.balance += exitingPlayer.bet; // Возврат ставки
            socket.emit('auth_success', { id: player.id, balance: player.balance }); // Обновление баланса
        }

        // 1. Удаляем игрока из списка стола
        table.players = table.players.filter(p => p.id !== player.id);
        table.currentPlayers = table.players.length;

        // 2. Очищаем сокет
        socket.leave(tableId);
        player.currentTableId = null;

        // 3. Обновляем состояние стола:
        if (table.players.length === 0) {
            table.state = 'WAITING_FOR_PLAYERS';
        } else if (table.state === 'READY_TO_START') {
            // Перепроверяем, все ли оставшиеся игроки сделали ставку
            const allBetsIn = table.players.every(p => p.bet > 0);
            if (!allBetsIn) {
                table.state = 'WAITING_FOR_BETS';
            }
        }
        this.sendTableState(table); 

        // 4. Отправляем команду клиенту И обновленный список столов
        socket.emit('return_to_lobby', { tables: this.broadcastTableList() });
        this.broadcastTableList();
    }

    // --- ЛОГИКА ИГРЫ БЛЭКДЖЕК (КЛЮЧЕВЫЕ ИСПРАВЛЕНИЯ ЗДЕСЬ) ---

    sendTableState(table) {
        const tableState = {
            id: table.id,
            state: table.state, // 'WAITING_FOR_BETS', 'READY_TO_START', 'PLAYER_TURN', 'DEALER_TURN', 'RESULTS'
            dealerHand: table.dealerHand,
            dealerScore: calculateScore(table.dealerHand),
            activePlayerId: table.activePlayerIndex !== undefined && table.activePlayerIndex !== -1 && table.players[table.activePlayerIndex] ? table.players[table.activePlayerIndex].id : null,
            players: table.players.map(p => ({
                id: p.id,
                username: p.username,
                bet: p.bet,
                hand: p.hand,
                score: calculateScore(p.hand),
                active: p.active
            }))
        };
        this.io.to(table.id).emit('table_state', tableState);
    }

    placeBet(socket, tableId, amount) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || table.state !== 'WAITING_FOR_BETS') {
            socket.emit('error_message', 'Сейчас нельзя делать ставки.');
            return;
        }

        const tablePlayer = table.players.find(p => p.id === player.id);
        if (!tablePlayer) return;

        if (amount < table.minBet) {
             socket.emit('error_message', `Минимальная ставка: ${table.minBet}.`);
             return;
        }

        if (player.balance < amount) {
            socket.emit('error_message', 'Недостаточно средств.');
            return;
        }

        // Если ставка уже была, возвращаем старую ставку в баланс
        if (tablePlayer.bet > 0) {
             player.balance += tablePlayer.bet;
        }

        // Обновление баланса и ставки
        player.balance -= amount;
        tablePlayer.bet = amount;
        
        // Отправляем игроку обновленный баланс
        socket.emit('auth_success', { id: player.id, balance: player.balance });

        // ПРОВЕРКА СОСТОЯНИЯ ГОТОВНОСТИ:
        const allBetsIn = table.players.every(p => p.bet > 0);
        
        if (allBetsIn && table.players.length > 0) {
            table.state = 'READY_TO_START';
        }
        
        this.sendTableState(table);
        this.broadcastTableList();
    }
    
    /**
     * НОВОЕ: Обработчик для явной команды "Начать игру"
     */
    startGameCommand(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || table.state !== 'READY_TO_START') {
            socket.emit('error_message', 'Игра еще не готова к старту.');
            return;
        }
        
        // Только первый игрок за столом может запустить игру
        const firstPlayer = table.players[0];
        if (firstPlayer.id !== player.id) {
            socket.emit('error_message', 'Только игрок, создавший/зашедший первым, может начать игру.');
            return;
        }
        
        // Запуск игры
        this.startGame(table);
    }
    
    startGame(table) {
        // 1. Сброс и раздача карт
        table.deck.reset();
        table.dealerHand = [];
        table.players.forEach(p => {
            p.hand = [];
            p.active = true; // Снова активны для игры
            // Раздаем по 2 карты
            p.hand.push(table.deck.draw()); 
            p.hand.push(table.deck.draw()); 
        });

        // Раздача дилеру
        table.dealerHand.push(table.deck.draw()); // Первая карта открыта
        table.dealerHand.push(table.deck.draw()); // Вторая карта закрыта (пока)

        // 2. Установка активного игрока и состояния
        table.activePlayerIndex = 0;
        table.state = 'PLAYER_TURN'; // Начинаем с первого игрока
        
        // Проверяем первый BlackJack
        this.checkInitialBlackjack(table);
    }

    checkInitialBlackjack(table) {
        const dealerScore = calculateScore(table.dealerHand);
        let hasBlackjack = false;

        // Проверка игроков на BJ
        for (const p of table.players) {
            if (calculateScore(p.hand) === 21) {
                p.active = false; // Заканчиваем ход игрока
                hasBlackjack = true;
            }
        }
        
        // Если у дилера 10 или Туз, и есть BJ, то открываем вторую карту, иначе оставляем закрытой
        if (hasBlackjack && dealerScore === 21) {
            // Дилер и игрок - ничья, или дилер выигрывает
            // Расчет результатов будет при checkResults, сейчас просто отключаем игрока
        }
        
        // Переход к следующему активному игроку
        this.moveToNextPlayer(table);
    }
    
    // Вспомогательная функция для перехода к следующему активному игроку
    moveToNextPlayer(table) {
        let nextIndex = table.activePlayerIndex + 1;
        let foundNext = false;

        // Ищем следующего активного игрока
        while (nextIndex < table.players.length) {
            if (table.players[nextIndex].active) {
                table.activePlayerIndex = nextIndex;
                foundNext = true;
                break;
            }
            nextIndex++;
        }

        if (!foundNext) {
            // Игроки закончили, очередь дилера
            table.state = 'DEALER_TURN';
            this.dealerPlay(table);
            return;
        }
        
        this.sendTableState(table);
    }

    hit(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || table.state !== 'PLAYER_TURN' || table.players[table.activePlayerIndex].id !== player.id) {
            socket.emit('error_message', 'Сейчас не ваш ход.');
            return;
        }

        const tablePlayer = table.players[table.activePlayerIndex];
        
        // Добавляем карту
        tablePlayer.hand.push(table.deck.draw());
        const score = calculateScore(tablePlayer.hand);

        if (score > 21) {
            // Перебор (Bust)
            tablePlayer.active = false;
            this.moveToNextPlayer(table);
        } else if (score === 21) {
            // 21
            tablePlayer.active = false;
            this.moveToNextPlayer(table);
        } else {
             // Ход продолжается, просто отправляем новое состояние
             this.sendTableState(table);
        }
    }

    stand(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || table.state !== 'PLAYER_TURN' || table.players[table.activePlayerIndex].id !== player.id) {
            socket.emit('error_message', 'Сейчас не ваш ход.');
            return;
        }

        const tablePlayer = table.players[table.activePlayerIndex];
        
        // Игрок закончил ход
        tablePlayer.active = false;
        
        this.moveToNextPlayer(table);
    }

    dealerPlay(table) {
        // Открываем вторую карту дилера
        const secondCard = table.dealerHand[1];
        let dealerScore = calculateScore(table.dealerHand);

        while (dealerScore < 17) {
            table.dealerHand.push(table.deck.draw());
            dealerScore = calculateScore(table.dealerHand);
        }
        
        // После окончания хода дилера - показываем результаты
        this.checkResults(table);
    }

    checkResults(table) {
        const dealerScore = calculateScore(table.dealerHand);
        
        table.players.forEach(p => {
            const player = this.players[p.id];
            const playerScore = calculateScore(p.hand);
            let resultMessage = 'Проиграл';
            let winnings = 0;
            
            if (playerScore > 21) {
                // Перебор
                winnings = -p.bet; 
                resultMessage = 'Перебор! 📉';
            } else if (dealerScore > 21) {
                // Дилер перебор
                winnings = p.bet; // Выигрыш 1:1
                resultMessage = 'Дилер перебор! Вы выиграли! 🎉';
            } else if (playerScore === 21 && p.hand.length === 2) {
                // Блэкджек (3:2)
                if (dealerScore === 21) {
                    winnings = 0; // Push
                    resultMessage = 'Blackjack/Blackjack. Ничья. 🤝';
                } else {
                    winnings = p.bet * 1.5;
                    resultMessage = 'BLACKJACK! Вы выиграли 3:2! 💰';
                }
            } else if (playerScore > dealerScore) {
                // Выигрыш
                winnings = p.bet;
                resultMessage = 'Вы выиграли! 🥳';
            } else if (playerScore < dealerScore) {
                // Проигрыш
                winnings = -p.bet;
                resultMessage = 'Вы проиграли. 😞';
            } else {
                // Ничья (Push)
                winnings = 0;
                resultMessage = 'Ничья (Push). 😐';
            }
            
            // Расчет итогового баланса
            player.balance += p.bet + winnings;
            
            // Отправляем игроку обновленный баланс и сообщение о результате
            this.io.to(player.id).emit('auth_success', { id: player.id, balance: player.balance });
            this.io.to(player.id).emit('game_result', { message: resultMessage, winnings: winnings });
        });

        table.state = 'RESULTS';
        this.sendTableState(table);
    }

    // ... (hit, stand, checkResults, dealerPlay, updateBlackjackState - должны быть здесь) ...

    // Обработчик отключения (должен быть в коде, чтобы возвращать игрока в лобби)
    handleDisconnect(socket) {
        const player = this.players[socket.id];
        if (player && player.currentTableId) {
             // Используем leaveTable для корректного выхода и возврата ставки
             this.leaveTable(socket); 
        }
        delete this.players[socket.id];
        this.broadcastTableList();
    }
    
    // --- ПАКЕТНЫЙ ЦИКЛ ОБНОВЛЕНИЯ (GAME LOOP) ---
    startTableLoop() {
        setInterval(() => {
            Object.values(this.tables).forEach(table => {
                // Логика сброса раунда после результатов
                if (table.gameType === 'Blackjack' && table.state === 'RESULTS') {
                    // Переход к новому раунду ставок
                    table.state = 'WAITING_FOR_BETS';
                    table.dealerHand = [];
                    table.players.forEach(p => {
                        p.bet = 0;
                        p.hand = [];
                        p.active = true; // Снова активны для следующей ставки
                    });
                    this.sendTableState(table);
                }
            });
            this.broadcastTableList(); // Регулярное обновление списка столов
        }, 3000); // Обновляем каждые 3 секунды
    }
    
    // --- ЛОГИКА ПОКЕРА (заглушка) ---
    // (Здесь должны быть методы fold, call_check, raise, но для Блэкджека они не нужны)
    // ...
}

module.exports = { GameServerLogic, calculateScore };