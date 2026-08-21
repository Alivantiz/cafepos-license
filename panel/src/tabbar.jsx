// Нижняя панель разделов — только на телефоне. Бургер требовал двух касаний
// (открыть меню, выбрать) и жил в верхнем углу, куда большой палец не достаёт.
// Иконки нарисованы прямо здесь: в панели нет библиотеки иконок, а тащить её
// ради пяти штук незачем.
const I = (props) => (
  <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props} />
)

const ICONS = {
  // Сводка — столбики графика
  summary: <I><path d="M5 20V11M12 20V4M19 20v-6" /></I>,
  // Клиенты — витрина с навесом
  clients: <I><path d="M4 9h16l-1.2-4.2A1 1 0 0 0 17.8 4H6.2a1 1 0 0 0-1 .8L4 9Z" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" /><path d="M10 20v-5h4v5" /></I>,
  // Заявки — входящий лоток
  requests: <I><path d="M4 13h4l1.5 3h5L16 13h4" /><path d="M5.6 5.4 4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5l-1.6-7.6a1 1 0 0 0-1-.8H6.6a1 1 0 0 0-1 .8Z" /></I>,
  // Накладные — лист со строками
  invoices: <I><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z" /><path d="M14 3v4h4M9 12h6M9 16h4" /></I>,
  // Ещё — остальные разделы
  more: <I><path d="M4 6h16M4 12h16M4 18h10" /></I>,
}

/**
 * tabs — [{id, label, badge, urgent}], last one is «Ещё».
 * Пять — потолок: шестая иконка на узком экране уже не даёт подписи поместиться.
 */
export default function TabBar({ tabs, active, onPick }) {
  return (
    <nav className="tabbar">
      {tabs.map(t => (
        <button key={t.id} className={'tab' + (active === t.id ? ' active' : '')}
          onClick={() => onPick(t.id)} aria-label={t.label}>
          <span className="tab-ico">
            {ICONS[t.id] || ICONS.more}
            {t.badge > 0 && <i className={'dot' + (t.urgent ? ' urgent' : '')}>{t.badge > 99 ? '99' : t.badge}</i>}
          </span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
