/**
 * Block B — платёжные фолт-сценарии x402 (публичный слой).
 *
 * Контрактные типы и примитивы. Реализации сценариев v1-транша
 * добавляются в ветке block-b/v1-scenarios.
 */

export {
  rolesForFamily,
  parseScenarioId,
  scenarioId,
  validateScenarioId,
  type Family,
  type SutRole,
  type RoleAssignment,
  type ScenarioIdParts,
} from './BlockBRoles';

export {
  PassthroughPaymentFaultInjector,
  resolveDirective,
  passthrough,
  type PaymentFaultInjector,
  type FaultDirective,
  type HookCtx,
  type DirectiveResolution,
  type OutgoingPaymentRequest,
  type SettlementObservation,
  type SettlementPhase,
  type PaymentFact,
  type PaymentFactKind,
} from './PaymentFaultInjector';

export {
  validateScenarioSpec,
  validateRunConfig,
  BLOCK_B_FAMILY_ORDER,
  type BlockBScenarioSpec,
  type BlockBRunConfig,
  type BlockBVerdict,
  type BlockBGate,
  type BlockBGateResult,
} from './BlockBScenario';

export {
  AutoFundingProvider,
  ManualFundingProvider,
  ManualTopUpRequiredError,
  type FundingProvider,
  type FundingReport,
  type FundingSource,
  type FaucetClient,
  type FaucetDripResult,
  type BalanceSource,
  type Amount as FundingAmount,
} from './FundingProvider';

export {
  canonicalResourceBody,
  fingerprintRequest,
  type CanonicalResourceBody,
  type RequestFingerprint,
} from './CanonicalResource';

export { S_BC_01_BadSignature, corruptPaymentPayload } from './examples/S_BC_01_BadSignature';
