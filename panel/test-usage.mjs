// Проверка свёрток дневных итогов — единственная в панели логика, где можно
// молча посчитать деньги неверно. Запуск: node panel/test-usage.mjs
import assert from 'node:assert/strict'
import { window_, isoDay } from './public/_worker.js'

const day = (shift) => isoDay(shift)

// Ровно на границе окна: -7 включается, -8 нет. Иначе «выручка за неделю»
// незаметно превращается в выручку за восемь дней.
{
  const w = window_([
    { day: day(-8), revenue: 1000, receipts: 1 },
    { day: day(-7), revenue: 2000, receipts: 2 },
    { day: day(0), revenue: 3000, receipts: 3 },
  ])
  assert.equal(w.revenue7, 5000, 'в неделю входят -7 и сегодня')
  assert.equal(w.receipts7, 5)
  assert.equal(w.revenue30, 6000, 'в месяц входит всё')
}

// Средний чек считается от тридцати дней, а не от недели.
{
  const w = window_([
    { day: day(-20), revenue: 10000, receipts: 5 },
    { day: day(-1), revenue: 5000, receipts: 5 },
  ])
  assert.equal(w.avgCheck, 1500, '15000 / 10')
}

// Ноль чеков не должен давать NaN или деление на ноль.
{
  const w = window_([{ day: day(-1), revenue: 0, receipts: 0 }])
  assert.equal(w.avgCheck, 0)
  assert.equal(w.revenue7, 0)
}

// Прошлая неделя — окно [-14, -7), без пересечения с текущей: иначе процент
// роста считался бы от куска самого себя и всегда выглядел бы приличным.
{
  const w = window_([
    { day: day(-13), revenue: 1000, receipts: 1 },
    { day: day(-7), revenue: 9999, receipts: 1 },
    { day: day(-1), revenue: 2000, receipts: 1 },
  ])
  assert.equal(w.prevRevenue7, 1000, 'день -7 уже в текущей неделе, не в прошлой')
  assert.equal(w.revenue7, 11999)
}

// Пустая история — все нули, ничего не падает.
{
  const w = window_([])
  assert.deepEqual(
    [w.revenue7, w.receipts7, w.revenue30, w.avgCheck, w.prevRevenue7], [0, 0, 0, 0, 0])
}

console.log('Свёртки итогов: все проверки прошли')
