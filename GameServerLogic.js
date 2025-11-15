// GameServerLogic.js (НОВАЯ, ИСПРАВЛЕННАЯ ВЕРСИЯ)

// --- Утилиты Карт ---
const cardRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const cardSuits = ['C', 'D', 'H', 'S']; // Clubs, Diamonds, Hearts, Spades

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
        if (this.cards.length === 0) this.reset();
        return this.cards.pop();
    }
}

// --- Класс Стола Блэкджека (встроен) ---
class BlackjackTable {
    constructor(tableData, io) {
        this.id = tableData.id;
        this.name = tableData.name;
        this.maxPlayers = tableData.maxPlayers;
        this.isPrivate = tableData.isPrivate || false;
        this.password = tableData.password || null;
        this.isUserCreated = tableData.isUserCreated || false;
        
        this.io = io;
        this.deck = new Deck();
        this.players = {}; // { playerId: { playerObj, hand: [], bet: 0, status: 'betting', isBot: false } }
        this.dealerHand = [];
        this.state = 'WAITING_FOR_BETS';
        this.gameType = 'Blackjack';
        this.botCounter = 1;
        this.minBet = tableData.minBet || 10;
    }

    addPlayer(playerObj, wantsBots = false) {
        if (Object.keys(this.players).length >= this.maxPlayers) return false;
        
        this.players[playerObj.id] = { 
            playerObj, 
            hand: [], 
            bet: 0, 
            status: 'betting',
            isBot: playerObj.isBot
        };

        // Если это публичный стол, заполняем ботами
        if (wantsBots && !this.isUserCreated) {
            this.fillWithBots();
        }

        // Если бот добавлен, он СРАЗУ делает ставку (КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ)
        if (playerObj.isBot) {
            this.placeBet(playerObj.id, this.minBet, true); 
        }

        this.io.to(playerObj.id).emit('table_state', this.getPublicTableData());
        this.io.to(this.id).emit('chat_message', { username: 'SERVER', message: `${playerObj.username} сел за стол.` });
        return true;
    }
    
    removePlayer(playerId) {
        if (!this.players[playerId]) return;
        const playerUsername = this.players[playerId].playerObj.username;
        delete this.players[playerId];
        
        this.io.to(this.id).emit('chat_message', { username: 'SERVER', message: `${playerUsername} покинул стол.` });
        
        if (this.state === 'PLAYER_TURN' && this.getCurrentPlayerId() === playerId) {
            this.goToNextPlayer(); 
        }
    }

    fillWithBots() {
        while (Object.keys(this.players).length < this.maxPlayers) {
            const botId = `bot_${this.id}_${this.botCounter++}`;
            const botPlayer = { id: botId, username: `Бот-${this.botCounter-1}`, balance: 99999, isBot: true };
            this.addPlayer(botPlayer);
        }
    }
    
    botTurn(botId) {
        const p = this.players[botId];
        if (!p || !p.isBot || p.status !== 'active') return;

        const value = calculateScore(p.hand);
        
        if (value < 17) {
            setTimeout(() => this.handleHit(botId), 1500); 
        } else {
            setTimeout(() => this.handleStand(botId), 1500); 
        }
    }
    
    getPublicTableData() {
        // Упрощаем данные для клиента
        const dealerScore = calculateScore(this.dealerHand);
        return {
            state: this.state,
            // Рука дилера: скрываем вторую карту, если идет игра
            dealerHand: this.state === 'PLAYER_TURN' ? [this.dealerHand[0], 'BACK'] : this.dealerHand,
            dealerScore: this.state === 'PLAYER_TURN' ? calculateScore([this.dealerHand[0]]) : dealerScore,
            
            players: Object.values(this.players).map(p => ({
                id: p.playerObj.id,
                username: p.playerObj.username,
                bet: p.bet,
                hand: p.hand,
                score: calculateScore(p.hand),
                status: p.status,
                active: p.status === 'active' // Флаг для подсветки
            }))
        };
    }
    
    getCurrentPlayerId() {
        const activePlayer = Object.values(this.players).find(p => p.status === 'active');
        return activePlayer ? activePlayer.playerObj.id : null;
    }
    
    goToNextPlayer() {
        const playerIds = Object.keys(this.players);
        const currentActiveIndex = playerIds.findIndex(id => this.players[id].status === 'active');
        
        if (currentActiveIndex !== -1) {
            this.players[playerIds[currentActiveIndex]].status = 'stood';
        }

        let nextPlayerId = null;
        // Ищем следующего игрока, который еще не ходил
        for(let i = 1; i <= playerIds.length; i++) {
            const nextId = playerIds[(currentActiveIndex + i) % playerIds.length];
            const p = this.players[nextId];
            
            if (p.status !== 'busted' && p.status !== 'stood' && p.bet > 0) {
                nextPlayerId = nextId;
                break;
            }
        }
        
        if (nextPlayerId) {
            this.players[nextPlayerId].status = 'active';
            
            this.io.to(this.id).emit('player_turn', { 
                activePlayerId: nextPlayerId
            });

            if (this.players[nextPlayerId].isBot) {
                this.botTurn(nextPlayerId);
            }
        } else {
            this.dealerPlay();
        }
    }

    placeBet(playerId, amount, isBotAuto = false) {
        const p = this.players[playerId];
        
        if (this.state !== 'WAITING_FOR_BETS' || !p || p.playerObj.balance < amount || p.bet > 0) {
            if (!isBotAuto) this.io.to(playerId).emit('error_message', 'Нельзя сделать ставку.');
            return false;
        }

        p.bet = amount;
        p.playerObj.balance -= amount;
        p.status = 'ready';
        
        if (!isBotAuto) {
            this.io.to(playerId).emit('bet_accepted', { newBalance: p.playerObj.balance });
        }

        // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: Начинаем игру, как только ВСЕ игроки сделали ставку
        const allReady = Object.values(this.players).every(p => p.status === 'ready' || p.status === 'busted');
        if (allReady) {
            this.startGame();
        }
        return true;
    }

    startGame() {
        this.deck.reset();
        this.dealerHand = [];
        this.state = 'DEALING';
        
        const playerIds = Object.keys(this.players);
        
        playerIds.forEach(id => {
            this.players[id].hand = [];
            this.players[id].status = 'ready';
        });
        
        if (playerIds.length > 0) {
             this.players[playerIds[0]].status = 'active';
        }

        for (let i = 0; i < 2; i++) {
            Object.values(this.players).forEach(p => p.hand.push(this.deck.draw()));
            this.dealerHand.push(this.deck.draw());
        }
        
        this.state = 'PLAYER_TURN';
        this.io.to(this.id).emit('table_state', this.getPublicTableData());

        if (playerIds.length > 0) {
             const firstPlayerId = playerIds[0];
             this.io.to(this.id).emit('player_turn', { activePlayerId: firstPlayerId });
             if (this.players[firstPlayerId].isBot) {
                 this.botTurn(firstPlayerId);
             }
        }
    }
    
    handleHit(playerId) {
        const p = this.players[playerId];
        if (this.state !== 'PLAYER_TURN' || p.status !== 'active') return;

        p.hand.push(this.deck.draw());
        
        this.io.to(this.id).emit('table_state', this.getPublicTableData()); // Обновляем стол

        if (calculateScore(p.hand) > 21) {
            p.status = 'busted';
            this.io.to(this.id).emit('player_busted', { playerId });
            this.goToNextPlayer();
        } else if (p.isBot) {
            this.botTurn(playerId);
        }
    }

    handleStand(playerId) {
        const p = this.players[playerId];
        if (this.state !== 'PLAYER_TURN' || p.status !== 'active') return;

        p.status = 'stood';
        this.io.to(this.id).emit('player_stood', { playerId });
        this.goToNextPlayer();
    }
    
    dealerPlay() {
        this.state = 'DEALER_TURN';
        this.io.to(this.id).emit('table_state', this.getPublicTableData()); // Показываем скрытую карту

        const dealerPlayLoop = () => {
             if (calculateScore(this.dealerHand) < 17) {
                this.dealerHand.push(this.deck.draw());
                this.io.to(this.id).emit('table_state', this.getPublicTableData());
                setTimeout(dealerPlayLoop, 1000);
            } else {
                this.checkWinner();
            }
        };
        setTimeout(dealerPlayLoop, 1000);
    }
    
    checkWinner() {
        this.state = 'FINISHED';
        const dealerScore = calculateScore(this.dealerHand);
        const results = {};

        Object.values(this.players).forEach(p => {
            const playerScore = calculateScore(p.hand);
            let winAmount = 0;
            let message = '';
            
            if (p.status === 'busted') {
                message = `Перебор (${playerScore}). Проигрыш ${p.bet}.`;
            } else if (dealerScore > 21) {
                message = `У дилера перебор (${dealerScore}). Выигрыш ${p.bet}.`;
                winAmount = p.bet * 2;
            } else if (playerScore === dealerScore) {
                message = `Ничья (${playerScore}). Ставка ${p.bet} возвращена.`;
                winAmount = p.bet;
            } else if (playerScore > dealerScore) {
                message = `Выигрыш (${playerScore} vs ${dealerScore}). Выигрыш ${p.bet}.`;
                winAmount = p.bet * 2;
            } else {
                message = `Проигрыш (${playerScore} vs ${dealerScore}). Проигрыш ${p.bet}.`;
            }
            
            p.playerObj.balance += winAmount;
            results[p.playerObj.id] = { message, newBalance: p.playerObj.balance };
        });
        
        this.io.to(this.id).emit('game_results', { results, dealerHand: this.dealerHand, dealerScore });
        
        // Сброс стола для следующего раунда
        setTimeout(() => {
            this.dealerHand = [];
            Object.values(this.players).forEach(p => {
                p.hand = [];
                p.bet = 0;
                p.status = 'betting';
                if (p.isBot) {
                    this.placeBet(p.playerObj.id, this.minBet, true); // Боты снова ставят
                }
            });
            this.state = 'WAITING_FOR_BETS';
            this.io.to(this.id).emit('table_state', this.getPublicTableData());
        }, 5000); // 5 секунд на просмотр результатов
    }
}


// --- ОСНОВНОЙ КЛАСС ЛОГИКИ СЕРВЕРА ---
class GameServerLogic {
    constructor(io) {
        this.io = io;
        this.players = {}; 
        this.nextPlayerId = 1;
        this.defaultBalance = 1000;
        
        // ИНИЦИАЛИЗАЦИЯ 3x3 СТОЛОВ
        this.tables = {
            'b1': new BlackjackTable({ id: 'b1', name: 'Быстрый Блэкджек (Боты)', maxPlayers: 4, minBet: 10 }, io),
            'b2': new BlackjackTable({ id: 'b2', name: 'Стол Новичков', maxPlayers: 4, minBet: 50 }, io),
            'b3': new BlackjackTable({ id: 'b3', name: 'Хайроллер', maxPlayers: 4, minBet: 100 }, io),
            
            // Покер (пока отключен, так как логика не реализована)
            // 'p1': { id: 'p1', gameType: 'Poker', ... } 
        };
        
        // ЗАПОЛНЯЕМ ПУБЛИЧНЫЙ СТОЛ БОТАМИ
        this.tables['b1'].fillWithBots();
    }
    
    // --- УТИЛИТЫ ---
    broadcastTableList() {
        const tableList = Object.values(this.tables).map(t => ({
             id: t.id, 
             name: t.name,
             gameType: t.gameType, 
             currentPlayers: Object.keys(t.players).length, 
             maxPlayers: t.maxPlayers, 
             minBet: t.minBet
        }));
        this.io.emit('update_table_list', tableList);
        return tableList;
    }
    
    // --- БАЗОВАЯ ЛОГИКА ---
    handleAuth(socket) {
        let player = this.players[socket.id];
        if (!player) {
            player = {
                id: socket.id,
                username: `Игрок-${this.nextPlayerId++}`,
                balance: this.defaultBalance,
                currentTableId: null,
                isBot: false,
                socket
            };
            this.players[socket.id] = player;
        }

        socket.emit('auth_success', { 
            id: player.id, 
            username: player.username, 
            balance: player.balance, 
            tables: this.broadcastTableList()
        });
    }

    joinTable(socket, tableId, wantsBots) {
        const player = this.players[socket.id];
        let table = this.tables[tableId];

        if (!player || !table || Object.keys(table.players).length >= table.maxPlayers) {
            return socket.emit('error_message', 'Стол недоступен или полон.');
        }
        
        if (player.currentTableId) this.leaveTable(socket); // Выходим из старого стола

        player.currentTableId = tableId;
        
        socket.join(tableId);
        table.addPlayer(player, wantsBots); // wantsBots используется здесь
        
        socket.emit('game_start', { tableId: tableId, gameType: table.gameType });
        this.broadcastTableList();
    }
    
    leaveTable(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;

        const tableId = player.currentTableId;
        const table = this.tables[tableId];
        
        if (table) {
            table.removePlayer(player.id);
            socket.leave(tableId);
            
            if (table.id === 'b1') { // Если это публичный стол, пополняем его ботами
                table.fillWithBots(); 
            }
            
            if (table.isUserCreated && Object.keys(table.players).length === 0) {
                 delete this.tables[table.id];
            }
        }
        
        player.currentTableId = null;
        
        // ИСПРАВЛЕНИЕ: Отправляем команду клиенту И обновленный список столов
        socket.emit('return_to_lobby', { tables: this.broadcastTableList() }); 
        this.broadcastTableList(); // Обновляем список для всех
    }

    handleDisconnect(socket) {
        const player = this.players[socket.id];
        if (player) {
            if (player.currentTableId) {
                this.leaveTable(socket); // Используем ту же логику выхода
            }
            delete this.players[socket.id];
        }
    }

    // --- ЛОГИКА ИГР ---
    placeBet(socket, tableId, amount) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];
        if (table && table.placeBet(player.id, amount)) {
            // Обновляем баланс игрока на стороне сервера
            player.balance -= amount;
            socket.emit('auth_success', { id: player.id, balance: player.balance });
        } else {
            socket.emit('error_message', 'Не удалось принять ставку.');
        }
    }

    hit(socket, tableId) {
        this.tables[tableId]?.handleHit(socket.id);
    }

    stand(socket, tableId) {
        this.tables[tableId]?.handleStand(socket.id);
    }
    
    pokerAction(socket, tableId, action, amount) {
        // Логика покера (пока не реализована)
        socket.emit('error_message', 'Покер временно недоступен.');
    }
}

module.exports = { GameServerLogic };