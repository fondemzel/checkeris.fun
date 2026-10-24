// Английские тексты. Файл собирает scripts/i18n_sync.mjs по site/m/i18n/ru.js —
// руками правятся только сами переводы: состав и порядок надписей скрипт всё равно
// приведёт обратно в соответствие с русским файлом.
//
// Пустая строка — не переведено: рядом комментарием русский текст. Пока перевода нет,
// на экране показывается русский вариант.

export const en = {
  island: {
    periods: {
      today: '', // Сегодня
      week: '', // Неделя
      month: '', // Месяц
      year: '', // Год
    },
  },
  common: {
    ops: ['operation', 'operations', 'operations'],
    receipts: ['receipt', 'receipts', 'receipts'],
    accounts: ['account', 'accounts', 'accounts'],
    purchases: ['purchase', 'purchases', 'purchases'],
    years: ['year', 'years', 'years'],
    failed: 'Didn’t work',
    unsaved: '', // Изменения не сохранены. Закрыть без сохранения?
    discard: '', // Не сохранять
    cancel: 'Cancel',
    yes: 'Yes',
    delete: 'Delete',
    remove: 'Remove',
    exclude: 'Remove',
    leave: 'Leave',
    disable: 'Disconnect',
    mark: 'Mark',
    skip: 'Exclude',
    move: 'Move',
    privacy: 'What Checker stores',
    agoNow: 'just now',
    agoMin: '{n} min ago',
    agoHour: '{n} h ago',
  },
  sources: {
    receipt: 'receipt',
    market: 'marketplace',
    manual: 'manual entry',
    bank: 'bank',
  },
  accountTypes: {
    Current: 'Current account',
    Credit: 'Credit card',
    Saving: 'Savings account',
    CurrentKids: 'Kids card',
    BNPL: 'Pay in instalments',
    Deposit: 'Deposit',
  },
  income: {
    one: 'Income',
    many: ['income', 'incomes', 'incomes'],
    noCategory: 'No category',
    all: 'All income',
    emptyFilter: 'No such income in this period',
    pick: 'Choose a category',
    pickFor: 'Choose a category for the income “{name}”',
    saved: 'Category set',
    savedMore: 'Category set · {n} more like this',
    affects: 'Changing the category will affect {n} {word} with the same description',
    channel: 'Received via',
    transferHint: 'A transfer to yourself — for example from a card at another bank — is marked in the category picker: it is not income, just your own money.',
    transferConfirm: 'Mark as a transfer to yourself? It will not count as income.',
    excludeConfirm: 'Ignore this income? It will disappear from income.',
    excluded: 'This income is no longer counted',
  },
  settings: {
    title: 'Settings',
    menu: {
      label: 'General',
      members: ['member', 'members', 'members'],
      banksNone: 'no banks connected',
      dark: 'Dark theme',
    },
    cats: {
      label: 'Categories',
      expense: 'Expenses',
      expenseTitle: 'Expense categories',
      incomeTitle: 'Income categories',
      expenseNote: '{groups} {gw} · {cats} {cw}',
      income: 'Income',
      groupsW: ['group', 'groups', 'groups'],
      catsW: ['category', 'categories', 'categories'],
      spendsW: ['expense', 'expenses', 'expenses'],
      unused: 'empty so far',
      listNote: '', // Категории общие: их видят и меняют все участники бюджета
      groupsBlock: 'Groups',
      manage: 'Manage',
      addGroup: 'Add a new group',
      newGroup: 'New group',
      newCat: 'New category',
      look: 'Colour and icon',
      group: 'Group',
      groupSettings: 'Group settings',
      shade: 'Category gradient',
      shadeFrom: 'Lightest',
      shadeTo: 'Most saturated',
      catsBlock: 'Categories',
      addCat: 'Add a category',
      nameNote: 'name',
      icon: 'Icon',
      iconSearch: 'Search: food, home, car…',
      iconOfGroup: 'Same as group',
      color: 'Colour',
      deleteGroup: 'Delete group',
      deleteGroupBusy: 'move or delete its categories first',
      deleteGroupConfirm: 'Delete the group “{name}”?',
      category: 'Category',
      inGroup: 'Group',
      hintPlaceholder: 'What belongs here',
      hintNote: 'a hint — helps sort purchases',
      deleteCat: 'Delete category',
      deleteCatNote: 'its expenses will have to move to another one',
      deleteIncomeNote: 'its income will have to move to another one',
      moveIncomeConfirm: 'Delete “{name}” and move its income to “{to}”?',
      deleteCatConfirm: 'Delete the category “{name}”?',
      moveNote: 'Deleting “{name}”. Choose where to move its {what}, otherwise they’ll be left without a category',
      moveWhat: 'spending and rules',
      moveTitle: 'Move to',
      moveWhatIncome: 'income and rules',
      moveConfirm: 'Delete “{name}” and move its expenses to “{to}”?',
      gone: 'This entry no longer exists',
    },
    profile: {
      label: 'Profile',
      block: 'Account',
      viaTelegram: 'Signed in with Telegram',
      viaPassword: 'Signed in with a password',
      footTelegram: '', // Вы входите в Чекер через Telegram
      footPassword: '', // Вы входите в Чекер по паролю
      nameLabel: 'Name',
      namePlaceholder: 'Your name',
      nameNote: 'how budget members see you',
      logout: 'Sign out on this device',
      logoutConfirm: 'Sign out on this device?',
    },
    budget: {
      label: 'Budget',
      main: 'General',
      members: 'Members',
      noteShared: '', // Все участники видят траты этого бюджета и могут добавлять свои
      noteAlone: '', // Пригласите семью, чтобы вести один бюджет на всех
      nameLabel: 'Budget name',
      nameNote: 'budget name',
      nameSaved: 'Name saved',
      you: 'you',
      owner: 'owner',
      receipts: ['receipt', 'receipts', 'receipts'],
      remove: 'Remove from budget',
      removeConfirm: 'Remove from the budget? They will return to their own budget; their expenses stay here.',
      invite: 'Invite',
      inviteNote: 'send a link by messenger or email',
      leave: 'Leave shared budget',
      leaveNote: 'you return to your own; your expenses stay here',
      notify: 'Notify about members’ spending',
      notifyNote: '', // Бот сообщит в Telegram, когда другой участник внесёт трату или доход
      notifyNoTelegram: 'Link Telegram in your profile to get messages about other members’ spending',
      leaveConfirm: 'Leave the shared budget? You will return to your own. Your expenses stay in the shared one.',
      export: {
        label: '', // Данные
        title: '', // Экспорт
        note: '', // Архив с тратами, доходами и категориями бюджета откроется в Excel. Его можно сохранить или отправить в любое приложение
        busy: '', // Готовлю архив…
        oldApp: '', // Чтобы поделиться архивом, обновите приложение
      },
    },
    banks: {
      label: 'Banks',
      block: 'Connected',
      note: '', // Операции приходят через этот телефон, а пароль банка Чекер не видит
      add: 'Connect a bank',
      addNote: 'available: {names}',
      addNoteSoon: 'coming soon: {names}',
      addNoteNone: 'all banks are connected',
      neverSynced: 'not updated yet',
      today: '{n} {word} today',
      todayNone: 'no operations today',
      todayNoneShop: 'no receipts today',
      refresh: 'Update operations',
      connect: 'Connect',
    },
    backup: {
      label: '', // Резервная копия
      every: '', // Как часто
      everyOpts: {
        1: '', // каждый день
        2: '', // раз в два дня
        3: '', // раз в три дня
        7: '', // раз в неделю
      },
      last: '', // Последняя копия
      never: '', // ещё не было
      failed: '', // Не вышло: {error}
      now: '', // Сделать копию сейчас
      share: '', // Поделиться последней копией
      note: '', // Копии сохраняются на телефоне в папке {folder} и не удаляются. В них все траты, доходы, категории и настройки бюджета
      noApp: '', // Резервные копии делает приложение Чекер для Android
      busy: '', // Делаю копию…
      done: '', // Копия готова
      noFile: '', // Копии ещё нет
    },
    perm: {
      label: '', // Разрешения
      note: '', // Чтобы траты из банков появлялись сами и вовремя, необходимо выдать Чекеру разрешения
      bg: '', // Работа в фоне без ограничений
      bgOk: '', // разрешено
      bgNo: '', // не разрешено
      autostart: '', // Автозапуск
      autostartNote: '', // на Xiaomi включите его для Чекера
      autostartOk: '', // включён
      autostartNo: '', // выключен
    },
    sync: {
      label: '', // Синхронизация
      all: '', // Для всех банков
      every: '', // Как часто обновлять
      everyNote: '', // Выберите период повторной синхронизации
      everyOpts: {
        0: '', // только вручную
        15: '', // каждые 15 минут
        30: '', // каждые 30 минут
        60: '', // раз в час
        180: '', // раз в 3 часа
      },
      wifi: '', // Только по Wi-Fi
      allNote: '', // Единые настройки синхронизации на все банки и магазины
      allOffNote: '', // Сейчас у каждого банка свои настройки, их можно поменять в его карточке
      lockedNote: '', // Сейчас действуют общие настройки, а эти заработают, если выключить «Для всех банков»
      ownNote: '', // Эти настройки действуют только для этого банка
      remind: '', // Напоминать о входе
      remindNote: '', // Если сессия банка устарела, пришлем напоминание в бот.
      remindNoTg: '', // Нужен вход через Telegram: напоминания приходят в бот
    },
    data: {
      label: 'Data',
      note: 'What Checker stores and how to delete it all',
      privacy: 'What data Checker stores',
      privacyNote: 'privacy policy',
      deleteNote: 'receipts, expenses, categories and edits — permanently',
    },
    deleteAccount: 'Delete account and all data',
    deleteConfirm: 'Delete your account? All receipts, manual entries, categories and edits will be gone.',
    deleteConfirm2: 'Are you sure? The account cannot be restored.',
    look: {
      label: 'Appearance',
      motion: 'Animations',
      motionNote: 'Rings, counters, sheets',
      allLabel: 'Turn on animations',
      allOn: 'all on',
      allOff: 'off',
      some: '{n} of {total}',
      kindsLabel: 'What to animate',
      kindsNote: '', // Без анимации элементы появляются сразу, без движения
      systemNote: '', // Анимаций не будет, пока в настройках телефона включено «Уменьшить движение»
      kindNotes: {
        ring: 'Smooth fill of rings and progress bars',
        counter: 'Smooth change of the total',
        sheets: 'Smooth display of menus and dialogs',
        sections: 'Smooth opening of list categories',
        swipe: 'Smooth list slide on period change',
        screens: '', // Плавный сдвиг при переходе на другой экран или вкладку
        peek: '', // Показывать стрелку при смене экранов и периодов
      },
      kinds: {
        ring: 'Ring and bar fill',
        counter: 'Total counter',
        sheets: 'Sheets and dialogs',
        sections: 'Opening sections',
        swipe: 'Slide on period swipe',
        screens: '', // Переходы между экранами
        peek: '', // Подсказка при свайпе
      },
    },
    limits: {
      label: '', // Лимиты
      none: '', // не заданы
      manage: '', // Управлять лимитами
      on: '', // Включить лимиты
      off: '', // выключены
      offTitle: '', // Лимиты выключены
      offNote: '', // Заданные лимиты сохранены — включите их снова в настройках
      offFoot: '', // Пока лимиты выключены, они нигде не показываются, но суммы сохраняются
      period: '', // Период
      periodNote: '', // Если сменить период, заданные лимиты пересчитаются пропорционально
      periods: {
        month: '', // Месяц
        quarter: '', // Квартал
        week: '', // Неделя
        day: '', // День
      },
      per: {
        month: '', // в месяц
        quarter: '', // в квартал
        week: '', // в неделю
        day: '', // в день
      },
      groups: '', // Группы
      groupsNote: '', // Чтобы задать лимит, нажмите на группу
      totalNote: '', // Всего на лимиты отведено {sum} {per}
      fixed: '', // зафиксирован
      cardTitle: '', // Лимит
      cardTitleAll: '', // Лимиты всех групп
      notSetShort: '', // не задан
      groupsWith: '', // с лимитом: {n} {w}
      edit: '', // Изменить
      set: '', // Задать
      setup: '', // Настроить
      limit: '', // Лимит
      spent: '', // Потрачено
      left: '', // Осталось
      overBy: '', // перерасход
      perDay: '', // в день до конца периода
      exceeded: '', // Лимит превышен
      forecast: '', // прогноз
      notStarted: '', // Период ещё не начался
      result: '', // Итог
      fit: '', // уложились
      saved: '', // сэкономили
      notSet: '', // Лимит не задан
      usually: '', // обычно
      noneNote: '', // Лимиты не заданы — задайте их в настройках
      toggle: '', // Лимит
      turnOn: '', // Включить
      fixShort: '', // Зафиксировать
      fix: '', // Зафиксировать лимит
      fixNote: '', // Не меняется, когда двигают лимиты других групп
      save: '', // Сохранить
      sheetNote: '', // Лимит общий для всех участников бюджета
    },
    support: {
      title: 'Support',
      new: 'New request',
      newNote: 'A question, a bug or a wish',
      newTitle: 'New request',
      ticket: 'Request',
      list: 'Requests',
      empty: 'No requests yet',
      unread: 'New reply',
      status: { new: 'Awaiting reply', answered: 'Answered', closed: 'Closed' },
      foot: 'The reply will come here and in Telegram. You can send a screenshot to {bot}',
      footNoBot: 'The reply will come here',
      placeholder: 'Message',
      newHint: 'Tell us what happened or what you would improve. We’ll reply here and in Telegram, usually within a day',
      send: 'Send',
      attach: 'Attach an image',
      attachClear: 'Remove the image',
      attachFail: 'Couldn’t open the image',
      sent: 'Sent — we’ll reply within a day',
      team: 'Checker support',
      attachment: 'attachment',
      replyFoot: 'The reply will come here and in Telegram',
      replyFootApp: 'The reply will come here',
      closed: 'This request is closed. If the question remains, write a new one',
      notFound: 'Request not found',
    },
    help: {
      label: 'Help',
      support: 'Support',
      supportNote: 'Questions, bugs, wishes',
      demo: 'Demo mode',
      demoNote: 'A year of a made-up person’s spending',
      note: '', // В демо-режиме показаны траты вымышленной семьи, и менять их нельзя
      pill: 'demo mode',
      offConfirm: 'Turn off demo mode and return to your own data?',
      off: 'Turn off',
    },
  },
  bankAdd: {
    title: 'Connect a bank',
    label: 'Not connected',
    ready: 'ready to connect',
    soon: 'coming soon',
    allConnected: 'All banks are already connected.',
    hint: '', // Вход проходит в окне банка на вашем телефоне, и пароль Чекер не видит
  },
  bankCard: {
    main: '', // Основные
    limits: {
      sber: '', // Сбер не даёт обновлять операции без вас: вход длится час, и каждый раз нужен пин-код. Снова осуществите вход, когда захотите увидеть свежие траты
    },
    expired: '', // Сессия устарела. Банк просит войти заново.
    notConnected: 'Not connected',
    soon: 'Connection coming later',
    connected: 'Connected · {ops} {opsWord}',
    connectedAt: ' · updated {when}',
    safety: {
      label: 'Data safety',
      rowNote: 'how sign-in works and what Checker sees',
      block: 'How it works',
      note: '', // Так устроено одинаково для всех банков
      loginBold: 'You sign in on your own phone',
      loginText: 'The app opens the bank’s window; you type the phone number, the SMS code and the password yourself',
      passwordBold: 'The password is never stored',
      passwordText: 'The bank session stays on your phone, encrypted: the key never leaves the device',
      serverBold: 'Only operations reach the server',
      serverText: 'Date, amount, merchant, the bank’s category and the last four digits of the card',
      privateBold: 'Never shared',
      privateText: 'Operations are visible only to you and the members of your budget',
    },
    accounts: {
      label: 'Accounts',
      hint: '', // Чекер берёт операции только с включённых счетов, выключенные в учёт не идут
      toggle: 'Count this account’s operations',
      kind: 'account',
      kinds: {
        card: 'Card',
        saving: 'Savings account',
        loan: 'Instalments',
        account: 'Account',
      },
      offConfirm: 'Stop using operations from this account? {ops} {opsWord} will no longer count.',
      on: 'The account counts again',
      off: 'The account no longer counts',
    },
    manage: {
      label: 'Manage',
      history: 'Load the whole history',
      sync: 'Update operations',
      relogin: 'Sign in to the bank again',
      forget: 'Disconnect the bank',
      forgetConfirm: 'Disconnect the bank? Loaded operations stay, new ones stop arriving.',
      wipe: 'Delete loaded operations',
      wipeConfirm: 'Delete this bank’s loaded operations? Receipts and manual entries stay.',
      wiped: 'Operations deleted: {n}',
      wipeShop: 'Delete loaded receipts',
      wipeShopConfirm: 'Delete the receipts loaded from {name} and disconnect it? Receipts that came from the tax service stay.',
      wipedShop: 'Receipts deleted: {n}',
    },
    sync: {
      added: 'New operations: {n}',
      none: 'No new operations',
      addedShop: 'New receipts: {n}',
      noneShop: 'No new receipts',
      failed: 'Bank: {why}',
      failedUnknown: 'didn’t work',
    },
  },
  wizard: {
    intro: {
      title: 'Let’s load the whole history from {bank}',
      subtitle: 'Years of spending and income in one place, sorted into categories.',
      safetyLabel: 'This is safe',
      safetyLoginBold: 'You sign in on your own phone.',
      safetyLoginText: 'You type the phone number, the SMS code and the password in the bank’s own window; Checker never sees them.',
      safetyReadBold: 'Read-only.',
      safetyReadText: 'Checker cannot transfer or pay anything — it only reads operations.',
      safetyYoursBold: 'Yours alone.',
      safetyYoursText: 'Operations are visible to you and the members of your budget, to nobody else.',
      planLabel: 'How it will go',
      plan1: 'You sign in to the bank',
      plan2: 'We look at your accounts and how far back they go',
      plan3: 'You choose what to load',
      plan4: 'We load it — usually 10–15 minutes',
      plan5: 'We show what we found and how it was sorted',
      start: 'Start',
    },
    ozon: {
      subtitle: 'Receipts for all your orders over the years — with items and prices, sorted into categories.',
      safetyLoginText: 'You type the phone number and the code in Ozon’s own window; Checker never sees them.',
      safetyReadText: 'Checker cannot order or pay for anything — it only reads receipts.',
      safetyYoursText: 'Receipts are visible to you and the members of your budget, to nobody else.',
      plan1: 'You sign in to Ozon',
      plan2: 'We count your orders by year',
      plan3: 'You choose the years',
      plan4: 'We load the receipts, order by order',
      plan5: 'We show what we found',
      wait: 'Looking at your orders by year — this may take a minute…',
      title: 'Orders over {n} {word}',
      hint: 'Tick the years whose receipts to load.',
      orders: ['order', 'orders', 'orders'],
      pickOne: 'Pick at least one year.',
      estimate: 'Picked {n} {word}. About {min} min.',
      already: '{n} Ozon {word} already here — they won’t be duplicated, only the missing ones are added.',
      receipts: 'added',
      ordersDone: 'orders',
      resultTitle: 'Done: {n} Ozon {word}',
      foundLabel: 'What we got',
      added: 'Added now',
      addedHint: 'the rest were already in Checker',
      items: 'Items in receipts',
      byYear: 'By year',
    },
    wb: {
      safetyLoginText: 'You type the phone number and the code in the Wildberries window; Checker never sees them.',
      plan1: 'You sign in to Wildberries',
      plan2: 'We count your receipts by year',
      plan4: 'We load the receipts one by one',
      wait: 'Looking at your receipts by year…',
      title: 'Receipts over {n} {word}',
      orders: ['receipt', 'receipts', 'receipts'],
      already: '{n} Wildberries {word} already here — they won’t be duplicated, only the missing ones are added.',
      ordersDone: 'receipts done',
      resultTitle: 'Done: {n} Wildberries {word}',
    },
    analyze: {
      wait: 'Looking at your accounts…',
      failed: 'It didn’t work: {why}',
      retry: 'Try again',
    },
    found: {
      title: 'Found {n} {word}',
      hint: 'Tick the accounts to take operations from — now and on every update. You can change this later on the bank’s page.',
      since: ' · since {year}',
      pickOne: 'Pick at least one account.',
      estimate: 'Picked {n}, history since {since}. About {min} min. Better on Wi-Fi — this is tens of megabytes.',
      estimateRough: 'Picked {n}. We’ll load every operation; a few minutes, better on Wi-Fi.',
      already: '{n} {word} already loaded — they won’t be duplicated, only the missing ones are added.',
      go: 'Start syncing',
    },
    load: {
      title: 'Loading the history',
      titleStopped: 'Loading paused',
      titleFailed: 'Loading interrupted',
      ops: 'operations',
      parts: 'parts',
      total: 'total',
      left: 'left',
      counting: 'Counting how many operations there are…',
      running: 'Loading operations…',
      now: 'Now: {account}, {year}',
      waiting: 'The bank asks to wait: we continue in {sec} s',
      keepOpen: 'You can put the app in the background, but don’t close it: loading runs while it is open.',
      savedFailed: '{why}. Everything loaded is saved — you can continue from the same place.',
      savedStopped: 'Everything loaded is saved — we’ll continue from the same place.',
      stop: 'Stop',
      resume: 'Continue loading',
    },
    marking: 'Sorting it out: matching receipts to operations, transfers between your own accounts, categories…',
    result: {
      title: 'Done: {n} {word}',
      span: '{years} {word} of history: from {from} to {to}',
      foundLabel: 'What we found',
      covered: 'Purchases with a receipt',
      coveredHint: 'the amount comes from the receipt, with items',
      expense: 'Spending without a receipt',
      expenseHint: 'sorted into categories: {percent}%',
      income: 'Income',
      transfer: 'Transfers between your accounts',
      transferHint: 'neither spending nor income',
      excluded: 'Not counted',
      rest: '{n} {word} without a category: transfers to people, cash, marketplaces. You can sort them in Spending — your choice for a merchant is remembered for all their operations.',
      restWord: ['expense', 'expenses', 'expenses'],
      byAccount: 'By account',
      since: 'since {year}',
      done: 'Done',
      markFailed: 'Could not sort it out: {why}',
    },
  },
};
