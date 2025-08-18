require('dotenv').config();
const { Telegraf } = require('telegraf');
const { YooCheckout } = require('@a2seven/yoo-checkout');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const payments = new Map();

// Инициализация YooKassa
const checkout = new YooCheckout({
    shopId: process.env.YOOKASSA_SHOP_ID,
    secretKey: process.env.YOOKASSA_SECRET_KEY
});

// Кешируем основную пригласительную ссылку
let cachedInviteLink = null;

// Функция для получения пригласительной ссылки
async function getInviteLink() {
  if (!cachedInviteLink) {
    cachedInviteLink = await bot.telegram.exportChatInviteLink(process.env.CHANNEL_ID);
  }
  return cachedInviteLink;
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
    // Показываем сообщение о обработке платежа
    await ctx.editMessageText(`
🔄 *Обработка платежа...*

Пожалуйста, подождите несколько секунд.
    `, { parse_mode: 'Markdown' });
    
    // Создаем платеж в YooKassa
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
        return_url: 'https://t.me/your_bot'
      },
      description: `Подписка на канал для пользователя ${ctx.from.id}`,
      metadata: {
        userId: ctx.from.id,
        paymentId: paymentId
      }
    };
    
    const payment = await checkout.createPayment(createPayload);
    
    // Сохраняем ID платежа в YooKassa
    payments.set(paymentId, { 
      ...paymentData, 
      yooId: payment.id,
      status: 'waiting_for_capture' 
    });
    
    // Отправляем пользователю ссылку на оплату
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
    
    // Проверяем статус платежа в YooKassa
    const paymentInfo = await checkout.getPayment(paymentData.yooId);
    
    if (paymentInfo.status === 'succeeded') {
      // Платеж успешен, предоставляем доступ
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

// Вебхук для обработки уведомлений от YooKassa
bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
bot.webhookCallback('/webhook')(async (ctx) => {
  const payment = ctx.request.body;
  
  if (payment.event === 'payment.waiting_for_capture') {
    try {
      // Подтверждаем платеж
      await checkout.capturePayment(payment.object.id);
      
      // Находим paymentId по metadata
      const paymentId = payment.object.metadata.paymentId;
      const userId = payment.object.metadata.userId;
      const paymentData = payments.get(paymentId);
      
      if (paymentData && paymentData.userId.toString() === userId.toString()) {
        // Предоставляем доступ
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
    } catch (err) {
      console.error('Ошибка при обработке вебхука:', err);
    }
  }
  
  ctx.status = 200;
});

bot.launch();
console.log('🟢 Бот запущен и готов к работе!');