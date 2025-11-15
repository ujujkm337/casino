// GameServerLogic.js (ФУНКЦИОНАЛ СЕРВЕРНОЙ ЛОГИКИ)

// --- УТИЛИТЫ КАРТ (МИНИМАЛЬНЫЕ) ---

const cardRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const cardSuits = ['C', 'D', 'H', 'S'];

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
        return this.cards.pop();
    }
}

// --- ОСНОВНОЙ КЛАСС ЛОГИКИ ---

class GameServerLogic {
    constructor(io) {
        this.io = io;
        this.players = {}; // { socketId: { id, username, balance, currentTableId } }
        this.nextPlayerId = 1;
        this.defaultBalance = 1000;
        
        // ИНИЦИАЛИЗАЦИЯ 3x3 СТОЛОВ
        this.tables = {
            // Блэкджек столы (max 4 игрока)
            'b1': { id: 'b1', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 4, players: [], state: 'WAITING_FOR_PLAYERS', dealerHand: [], minBet: 10, deck: new Deck(), activePlayerIndex: -1 },
            'b2': { id: 'b2', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 4, players: [], state: 'WAITING_FOR_PLAYERS', dealerHand: [], minBet: 50, deck: new Deck(), activePlayerIndex: -1 },
            'b3': { id: 'b3', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 4, players: [], state: 'WAITING_FOR_PLAYERS', dealerHand: [], minBet: 100, deck: new Deck(), activePlayerIndex: -1 },
            
            // Покер столы (max 3 игрока для упрощения)
            'p1': { id: 'p1', gameType: 'Poker', currentPlayers: 0, maxPlayers: 3, players: [], state: 'WAITING_FOR_PLAYERS', deck: new Deck(), communityCards: [], pot: 0, activePlayerIndex: -1, minBuyIn: 100 },
            'p2': { id: 'p2', gameType: 'Poker', currentPlayers: 0, maxPlayers: 3, players: [], state: 'WAITING_FOR_PLAYERS', deck: new Deck(), communityCards: [], pot: 0, activePlayerIndex: -1, minBuyIn: 500 },
            'p3': { id: 'p3', gameType: 'Poker', currentPlayers: 0, maxPlayers: 3, players: [], state: 'WAITING_FOR_PLAYERS', deck: new Deck(), communityCards: [], pot: 0, activePlayerIndex: -1, minBuyIn: 1000 }
        };
        
        this.startTableLoop();
    }
    
    // --- УТИЛИТЫ ---

    broadcastTableList() {
        const tableList = Object.values(this.tables).map(t => ({
            id: t.id,
            gameType: t.gameType,
            currentPlayers: t.players.length,
            maxPlayers: t.maxPlayers,
            state: t.state,
            minBet: t.minBet || t.minBuyIn // Добавляем мин.ставку/бай-ин
        }));
        this.io.emit('update_table_list', tableList);
        return tableList;
    }
    
    // --- БАЗОВАЯ ЛОГИКА ---
    
    handleAuth(socket) {
        // ... (логика аутентификации) ...
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

    joinTable(socket, tableId, gameType, wantsBots) {
        const player = this.players[socket.id];
        let table = this.tables[tableId];

        if (!player || !table || table.players.length >= table.maxPlayers) {
            return socket.emit('error_message', 'Стол недоступен или полон.');
        }

        player.currentTableId = tableId;
        // Проверяем, не пытается ли игрок присоединиться дважды
        if (!table.players.some(p => p.id === player.id)) {
            table.players.push({ 
                id: player.id, 
                username: player.username, 
                bet: 0, 
                hand: [], 
                active: true,
                isBot: false 
            });
        }
        
        socket.join(tableId);
        table.currentPlayers = table.players.length;
        
        if (wantsBots && table.gameType === 'Blackjack') {
             this.fillBlackjackWithBots(table);
        }

        this.io.to(tableId).emit('game_start', { tableId: tableId, gameType: gameType });
        this.broadcastTableList();
        
        if (table.state === 'WAITING_FOR_PLAYERS' && table.players.length >= 1) {
            table.state = 'WAITING_FOR_BETS';
        }
    }

    // --- БЛЭКДЖЕК ЛОГИКА ---

    fillBlackjackWithBots(table) {
        // ... (логика добавления ботов) ...
        while (table.players.length < table.maxPlayers) {
            const botId = `BOT-${Math.random().toString(36).substring(7)}`;
            table.players.push({
                id: botId,
                username: `Бот-${table.players.length + 1}`,
                bet: 10, // Боты сразу ставят минимальную ставку
                hand: [],
                active: true,
                isBot: true
            });
            table.currentPlayers = table.players.length;
        }
    }

    placeBet(socket, tableId, amount) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];
        const playerInTable = table.players.find(p => p.id === player.id);
        
        // Проверка: достаточно ли денег у игрока
        if (player.balance < amount) {
             return socket.emit('error_message', 'Недостаточно средств для этой ставки.');
        }

        if (table.state !== 'WAITING_FOR_BETS' || !playerInTable || playerInTable.bet > 0) {
            return socket.emit('error_message', 'Сейчас нельзя делать ставки.');
        }

        player.balance -= amount;
        playerInTable.bet = amount;
        
        // Отправка обновленного баланса
        socket.emit('auth_success', { id: player.id, balance: player.balance });

        const allBet = table.players.every(p => p.isBot || p.bet > 0);
        if (allBet) {
            table.state = 'DEALING';
            this.sendTableState(table);
            setTimeout(() => this.dealBlackjack(table), 1000);
        }
    }
    
    dealBlackjack(table) {
        // ... (логика раздачи и перехода хода) ...
        table.deck = new Deck(); // Новая колода
        table.dealerHand = [];
        table.players.forEach(p => { 
            p.hand = []; 
            p.active = true; 
        });

        // Раздача по две карты
        for (let i = 0; i < 2; i++) {
            table.players.filter(p => p.bet > 0).forEach(p => p.hand.push(table.deck.draw()));
            table.dealerHand.push(table.deck.draw());
        }

        // Начинаем ход первого игрока
        table.activePlayerIndex = table.players.findIndex(p => p.bet > 0);
        table.state = 'PLAYER_TURN';
        this.sendTableState(table);
    }
    
    // ... (hit, stand, checkResults, dealerPlay, updateBlackjackState - опущены для краткости, но должны быть реализованы) ...

    sendTableState(table) {
        const tableState = {
            id: table.id,
            state: table.state,
            dealerHand: table.dealerHand,
            dealerScore: calculateScore(table.dealerHand),
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

    // --- ПАКЕТНЫЙ ЦИКЛ ОБНОВЛЕНИЯ (GAME LOOP) ---
    startTableLoop() {
        setInterval(() => {
            Object.values(this.tables).forEach(table => {
                // В этом цикле должна быть логика для продвижения хода ботов и смены состояний.
                // Для MVP просто рассылаем текущее состояние.
                if (table.players.length > 0) {
                   this.sendTableState(table);
                }
            });
        }, 1000); // Обновление каждую секунду
    }
}

module.exports = { GameServerLogic };