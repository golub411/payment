require('dotenv').config();
const { Telegraf } = require('telegraf');
const { YooCheckout } = require('@a2seven/yoo-checkout');
const express = require('express');
const crypto = require('crypto');

// Инициализация приложения
const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const payments = new Map();

// Инициализация YooKassa
const checkout = new YooCheckout({
    shopId: process.env.YOOKASSA_SHOP_ID,
    secretKey: process.env.YOOKASSA_SECRET_KEY
});

// Middleware для обработки JSON
app.use(express.json());

// Кешируем основную пригласительную ссылку
let cachedInviteLink = null;

// Функция для получения пригласительной ссылки
async function getInviteLink() {
    if (!cachedInviteLink) {
        try {
            cachedInviteLink = await bot.telegram.exportChatInviteLink(process.env.CHANNEL_ID);
        } catch (error) {
            console.error('Ошибка при получении инвайт-ссылки:', error);
            throw error;
        }
    }
    return cachedInviteLink;
}

// Функция для проверки подписи уведомлений от ЮКассы
function verifyNotificationSignature(body, signature, secret) {
    const message = `${body.event}.${body.object.id}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(message);
    const expectedSignature = hmac.digest('hex');
    return signature === expectedSignature;
}

// Команда для начала оформления подписки
bot.command('start', (ctx) => {
    const userId = ctx.from.id;
    const paymentId = `yk_${Date.now()}`;
    payments.set(paymentId, { userId, status: 'pending' });
    
    ctx.replyWithMarkdown(`
🎉 *Добро пожаловать в наш эксклюзивный канал!*

Для доступа к закрытому контенту оформите подписку на 1 месяц.

💎 *Преимущества подписки:*
✔️ Доступ к эксклюзивным материалам
✔️ Закрытые обсуждения
✔️ Персональные уведомления
✔️ Поддержка создателей

Стоимость подписки: *100 рублей*
    `, {
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: '💳 Оплатить подписку', 
                    callback_data: `init_pay:${paymentId}` 
                }],
                [{ 
                    text: '❓ Помощь', 
                    url: 'https://t.me/your_support' 
                }]
            ]
        }
    });
});

// Обработка нажатия кнопки "Оплатить"
bot.action(/init_pay:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const paymentData = payments.get(paymentId);
    
    if (!paymentData || paymentData.userId !== ctx.from.id) {
        return ctx.answerCbQuery('⚠️ Ошибка платежа');
    }
    
    try {
        await ctx.editMessageText(`
🔒 *Подтверждение платежа*

Вы оформляете подписку на наш канал:
▫️ Сумма: *100 рублей*
▫️ Срок: *1 месяц*
▫️ Автопродление: *Нет*

Для продолжения подтвердите платеж:
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: '✅ Подтвердить оплату', 
                        callback_data: `confirm_pay:${paymentId}` 
                    }],
                    [{ 
                        text: '❌ Отменить', 
                        callback_data: `cancel_pay:${paymentId}` 
                    }]
                ]
            }
        });
    } catch (error) {
        console.error('Ошибка при обработке init_pay:', error);
        await ctx.answerCbQuery('⚠️ Произошла ошибка');
    }
    
    ctx.answerCbQuery();
});

// Обработка подтверждения платежа
bot.action(/confirm_pay:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const paymentData = payments.get(paymentId);
    
    if (!paymentData || paymentData.userId !== ctx.from.id) {
        return ctx.answerCbQuery('⚠️ Ошибка платежа');
    }
    
    try {
        await ctx.editMessageText(`
🔄 *Обработка платежа...*

Пожалуйста, подождите несколько секунд.
        `, { parse_mode: 'Markdown' });
        
        const createPayload = {
            amount: {
                value: '100.00',
                currency: 'RUB'
            },
            payment_method_data: {
                type: 'bank_card'
            },
            confirmation: {
                type: 'redirect',
                return_url: `https://t.me/${ctx.botInfo.username}`
            },
            description: `Подписка на канал для пользователя ${ctx.from.id}`,
            metadata: {
                userId: ctx.from.id,
                paymentId: paymentId,
                username: ctx.from.username || 'нет username'
            },
            capture: true
        };
        
        const payment = await checkout.createPayment(createPayload);
        
        payments.set(paymentId, { 
            ...paymentData, 
            yooId: payment.id,
            status: 'waiting_for_capture' 
        });
        
        await ctx.editMessageText(`
🔗 *Перейдите на страницу оплаты*

Для завершения оплаты перейдите по ссылке ниже и следуйте инструкциям.

После успешной оплаты вы автоматически получите доступ к каналу.
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '🌐 Перейти к оплате',
                        url: payment.confirmation.confirmation_url
                    }],
                    [{
                        text: '🔄 Проверить оплату',
                        callback_data: `check_payment:${paymentId}`
                    }]
                ]
            }
        });
        
    } catch (err) {
        console.error('Ошибка при создании платежа:', err);
        await ctx.editMessageText(`
⚠️ *Ошибка при обработке платежа*

Пожалуйста, попробуйте позже или свяжитесь с поддержкой.
        `, { parse_mode: 'Markdown' });
    }
    
    ctx.answerCbQuery();
});

// Обработка проверки платежа
bot.action(/check_payment:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const paymentData = payments.get(paymentId);
    
    if (!paymentData || paymentData.userId !== ctx.from.id) {
        return ctx.answerCbQuery('⚠️ Ошибка платежа');
    }
    
    try {
        await ctx.answerCbQuery('🔍 Проверяем платеж...');
        
        const paymentInfo = await checkout.getPayment(paymentData.yooId);
        
        if (paymentInfo.status === 'succeeded') {
            const inviteLink = await getInviteLink();
            
            try {
                await bot.telegram.unbanChatMember(process.env.CHANNEL_ID, ctx.from.id);
            } catch (e) {
                console.log('Пользователь не был забанен:', e.message);
            }
            
            await ctx.editMessageText(`
🎉 *Оплата успешно завершена!*

Спасибо за покупку подписки! Вот ваша персональная ссылка для доступа:

${inviteLink}

📌 *Важно:* Не передавайте эту ссылку другим пользователям!
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ 
                            text: '🚀 Перейти в канал', 
                            url: inviteLink 
                        }],
                        [{ 
                            text: '💬 Техподдержка', 
                            url: 'https://t.me/your_support' 
                        }]
                    ]
                }
            });
            
            payments.set(paymentId, { ...paymentData, status: 'completed' });
            
        } else {
            await ctx.answerCbQuery('⏳ Платеж еще не завершен', { show_alert: true });
        }
        
    } catch (err) {
        console.error('Ошибка при проверке платежа:', err);
        await ctx.answerCbQuery('⚠️ Ошибка при проверке платежа', { show_alert: true });
    }
});

// Обработка отмены платежа
bot.action(/cancel_pay:(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const paymentData = payments.get(paymentId);
    
    if (paymentData?.yooId) {
        try {
            await checkout.cancelPayment(paymentData.yooId);
        } catch (err) {
            console.error('Ошибка при отмене платежа:', err);
        }
    }
    
    payments.delete(paymentId);
    await ctx.editMessageText(`
🗑 *Платеж отменен*

Вы можете оформить подписку в любое время, воспользовавшись командой /start

Хорошего дня! ☀️
    `, { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
});

// Эндпоинт для вебхука ЮКассы
app.post('/yookassa-webhook', async (req, res) => {
    try {
        const signature = req.headers['content-signature'];
        
        if (!verifyNotificationSignature(req.body, signature, process.env.YOOKASSA_SECRET_KEY)) {
            console.error('Неверная подпись уведомления');
            return res.status(401).send();
        }
        
        const payment = req.body;
        
        if (payment.event === 'payment.succeeded') {
            const paymentId = payment.object.metadata.paymentId;
            const userId = payment.object.metadata.userId;
            const paymentData = payments.get(paymentId);
            
            if (paymentData && paymentData.userId.toString() === userId.toString()) {
                const inviteLink = await getInviteLink();
                
                try {
                    await bot.telegram.unbanChatMember(process.env.CHANNEL_ID, userId);
                } catch (e) {
                    console.log('Пользователь не был забанен:', e.message);
                }
                
                await bot.telegram.sendMessage(userId, `
🎉 *Оплата успешно завершена!*

Спасибо за покупку подписки! Вот ваша персональная ссылка для доступа:

${inviteLink}

📌 *Важно:* Не передавайте эту ссылку другим пользователям!
                `, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ 
                                text: '🚀 Перейти в канал', 
                                url: inviteLink 
                            }]
                        ]
                    }
                });
                
                payments.set(paymentId, { ...paymentData, status: 'completed' });
            }
        }
        
        res.status(200).send();
    } catch (err) {
        console.error('Ошибка в вебхуке:', err);
        res.status(500).send();
    }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

// Запуск бота
bot.launch()
    .then(() => console.log('🤖 Бот успешно запущен'))
    .catch(err => console.error('Ошибка запуска бота:', err));

// Graceful shutdown
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    process.exit();
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit();
});