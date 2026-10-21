# Блок B — полный реестр сценариев (28)

> Источник истины по маркировке и составу. Устаревшая маркировка
> `S-B-BC-NN` / `S-B-BS-NN` заменена на `S-BC-NN` / `S-BS-NN` (буква блока
> `B` из ID исключена, нумерация сохранена 1:1). Ранние документы (docx-матрица
> v1) читаются по старой маркировке; в коде принимается только новый формат
> (`validateScenarioId` в `src/blockb/BlockBRoles.ts`).

## Роли и семейства

| Семейство | Аргус | СУТ | Что наблюдаем |
|---|---|---|---|
| **S-BC** | плохой клиент | ресурсный сервер (принимает платежи) | как СУТ отклоняет/принимает платежи и выдаёт ресурс |
| **S-BS** | плохой сервер | клиент (платит за ресурс) | как СУТ защищает свои деньги и своё состояние |

Инвариант: **в одном прогоне СУТ исполняет ровно одну роль**. Кто есть СУТ,
объявляет оператор в конфиге точки подключения; раннер сверяет роль с
семейством и отказывает в запуске при несоответствии. Семейства никогда
не смешиваются в одном прогоне; порядок пакетного режима: сначала BC,
затем BS, каждое — со своим гейтом (канонический happy-path роли).

## Волны внедрения

- **Волна 1 (v1-транш, 10 сценариев)** — топ рейтинга поражаемости
  (settle-провалы → 402-цикл/двойные списания → replay) + дешёвая классика
  подписи/формата. Все — фаза 1, без mempool-доступа и upto-зависимостей.
- **Волна 2 (18 сценариев)** — остальной реестр; сюда же отнесены
  отцепляемые сценарии фазы 2 (S-BC-14, S-BC-15), требующие mempool-доступа
  и поддержки upto-схемы соответственно.

Волна — это ПОРЯДОК внедрения, а не урезание состава: полный охват — 28.

## Семейство S-BC — Аргус платит, СУТ принимает платежи (15)

| ID | Слаг | Фаза | Волна | Одно намеренное отказ-поведение | Якорь / источник |
|---|---|---|---|---|---|
| S-BC-01 | bad-signature | 1 | 1 | Повреждение поля signature в payload после честной подписи | CDP: `payload_verification_failed`; инвариант I2 |
| S-BC-02 | expired-valid-before | 1 | 1 | `validBefore` authorization в прошлом | CDP: `authorization_valid_before` |
| S-BC-03 | not-yet-valid | 1 | 2 | `validAfter` в будущем (клок-скью) | CDP: `authorization_valid_after` |
| S-BC-04 | nonce-reuse | 1 | 1 | Повторная отправка authorization с уже проведённым nonce | NDSS'26 TOCTOU-replay; I2 |
| S-BC-05 | insufficient-funds | 1 | 1 | Баланс кошелька ниже требуемой суммы | CDP: `insufficient_funds` / `unavailable_funds` |
| S-BC-06 | amount-mismatch | 1 | 2 | Подписанное `value` ≠ сумме из requirements | CDP: `invalid_exact_eip3009_authorization` |
| S-BC-07 | wrong-chain-id | 1 | 2 | `chainId` домена EIP-712 ≠ сети СУТ | CDP: `chain_id` mismatch |
| S-BC-08 | scheme-mismatch | 1 | 2 | `scheme` в payload ≠ `scheme` requirements | CDP: scheme mismatch |
| S-BC-09 | malformed-payload | 1 | 1 | Обрезанный/невалидный Base64-JSON `payment-signature` | классика robustness; читаемый отказ без 5xx |
| S-BC-10 | resource-mismatch | 1 | 2 | Платёж ссылается на другой ресурс, чем запрошен | arXiv 2605.30998: I3 (клиентская сторона) |
| S-BC-11 | duplicate-send | 1 | 2 | Двойная отправка одного валидного платежа подряд | гонка double-submit; I2 |
| S-BC-12 | wrong-asset | 1 | 2 | `asset` авторизации ≠ `asset` requirements | CDP: asset mismatch |
| S-BC-13 | wallet-kyt-edge | 1 | 2 | Кошелёк с граничным KYT-профилем (флаги по метаданным) | Coinbase CDP: KYT failures |
| S-BC-14 | frontrun-drain | 2 | 2 | Дрейн authorization из mempool до settle СУТ | USENIX Sec'26; отцепляемый: нужен mempool |
| S-BC-15 | upto-overdraft | 2 | 2 | Списание сверх потолка в схеме upto | arXiv 2605.30998: overdraft; отцепляемый: нужна upto-поддержка |

## Семейство S-BS — СУТ платит, Аргус принимает (13)

| ID | Слаг | Фаза | Волна | Одно намеренное отказ-поведение | Якорь / источник |
|---|---|---|---|---|---|
| S-BS-01 | 402-loop-after-pay | 1 | 1 | После успешной оплаты снова 402 за тот же ресурс | кейс «3 списания за 300 мс»; 402-цикл |
| S-BS-02 | late-double-charge | 1 | 1 | Повторное списание тем же nonce в окне наблюдения W | GitHub #1065; I2 |
| S-BS-03 | verify-pass-settle-fail | 1 | 1 | `verify` OK, `settle` «успех» без on-chain транзакции | GitHub #1065 (боль №1); denial of settlement |
| S-BS-04 | verify-always-fail | 1 | 2 | `verify` всегда отказывает с валидной причиной | CDP: verification failures |
| S-BS-05 | payto-substitution | 1 | 2 | Requirements ведут на `payTo` атакующего | arXiv 2605.30998: I3/I5; ADVISORY |
| S-BS-06 | oversize-amount | 1 | 1 | Requirements требуют больше реальной цены (переплата) | решение В2: приём переплаты = FAIL |
| S-BS-07 | resource-swap-after-pay | 1 | 2 | После оплаты отдаётся подменённое тело ресурса | I3; детекция по echo-fingerprint |
| S-BS-08 | premature-200-before-settle | 1 | 2 | 200 с ресурсом до settle | наблюдение состояния СУТ; ADVISORY |
| S-BS-09 | settle-pending-forever | 1 | 2 | `settle` возвращает pending бесконечно | denial of settlement; ADVISORY |
| S-BS-10 | requirements-poison | 1 | 2 | Структурно невалидные requirements (кривой адрес, мусор) | robustness клиента |
| S-BS-11 | replay-challenge | 1 | 1 | Повторное выставление того же nonce после успешной оплаты | NDSS'26 TOCTOU; FAIL при втором платеже |
| S-BS-12 | corrupt-transport | 1 | 2 | Битые заголовки / обрезанные тела 402/200 | robustness; FAIL при краше/зависании |
| S-BS-13 | premature-200 | 1 | 2 | 200 без всякого 402 (ресурс «бесплатно») | зеркало free shopping; ADVISORY |

## Связанные документы и код

- Матрица ожидаемого поведения, вердикты, CLI, фондирование, ресурс:
  `docs/block-b/MATRIX.md`.
- Контракт платёжного слоя: `src/blockb/` (PaymentFaultInjector, роли,
  FundingProvider, CanonicalResource), тесты `src/tests/blockb/`.
- Пререквизит запуска: фикс MAJ-4 (детерминированный nonce `0x0…0` →
  рандомный) — иначе S-BC-04/S-BS-11 теряют смысл на живом стенде.
