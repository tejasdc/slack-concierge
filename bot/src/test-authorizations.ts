/** Scoped authorizations for isolated checks that must open a temporary owner ledger. */
export const LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION='legacy-topic-completion-418aff41';
export const INBOX_BOOKKEEPING_RECOVERY_TEST_AUTHORIZATION='inbox-bookkeeping-recovery-2026-11-05';
export const HELD_WORK_MOVABILITY_TEST_AUTHORIZATION='held-work-movability-e4cf9b16';
export const INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION='inbox-unfiled-across-routers-2026-11-11';
export const HELD_RELEASE_PACING_TEST_AUTHORIZATION='held-release-pacing-2026-11-12';
export const INBOX_HELD_DUPLICATE_TEST_AUTHORIZATION='inbox-held-duplicate-2026-11-12';
export const INBOX_QUIET_SERVICE_TEST_AUTHORIZATION='inbox-quiet-service-4e58773e';
export const QUESTION_EXPIRY_SCOPE_TEST_AUTHORIZATION='question-expiry-scope-2026-11-13';
export const START_PACE_TEST_AUTHORIZATION='start-pace-2026-11-12';
export const PARKED_CODEX_FOLLOW_TEST_AUTHORIZATION='parked-codex-follow-2026-11-12';
export const IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION='implementation-edit-gate-2026-11-12';
export const CODEX_AUDIT_OFF_CODEX_TEST_AUTHORIZATION='codex-audit-off-codex-2026-11-12';
export const FROZEN_ASK_RESUME_TEST_AUTHORIZATION='frozen-ask-resume-2026-11-12';
export const PROTECTED_DURABILITY_TEST_AUTHORIZATION='protected-durability-92ed9a3d';
export const NOTIFICATION_TOPIC_CORRECTION_TEST_AUTHORIZATION='notification-topic-correction-2026-11-13';
export const CHATGPT_TOOL_READ_ACCEPTANCE_TEST_AUTHORIZATION='chatgpt-tool-read-acceptance-2026-11-13';
export const CODEX_SWITCH_RECEIPT_TEST_AUTHORIZATION='codex-switch-receipt-2026-11-13';
export const REQUEST_STANDING_TEST_AUTHORIZATION='request-standing-2026-11-16';
export const PEER_ANSWER_GUARANTEE_TEST_AUTHORIZATION='peer-answer-guarantee-2026-11-15';
// Lab publication incident85ee7a4e; exact canonical acceptance requested by parent9808.
export const LAB_PUBLICATION_TEST_AUTHORIZATION='lab-publication-85ee7a4e';

// Exact worker request a168df69 requires disposable journal processing acceptance.
export const JOURNAL_PROCESSING_TEST_AUTHORIZATION = "journal-processing-a168df69";
export const LAB_CONVERSATIONS_TEST_AUTHORIZATION='lab-conversations-2026-11-15';
export const THREAD_SURVIVES_ROUTER_HANDOFF_TEST_AUTHORIZATION='thread-survives-router-handoff-2026-11-16';
export const INPUT_REFUSAL_STREAK_TEST_AUTHORIZATION='input-refusal-streak-2026-11-16';
export const INBOX_SESSION_PIN_TEST_AUTHORIZATION='inbox-session-pin-b563714b';
export const NATIVE_HOME_REPAIR_TEST_AUTHORIZATION='native-home-repair-2026-11-17';
// The sealed private entrance marks its children as tests; the database-safety fixture's
// empty-schema and release-read children open only its own temporary ledger (request 02b26d77).
export const DATABASE_SAFETY_FIXTURE_TEST_AUTHORIZATION='database-safety-fixture-02b26d77';
export const CODEX_RUNTIME_MAINTENANCE_TEST_AUTHORIZATION='codex-runtime-maintenance-ledger-image';
export const KEEP_WORKING_TEST_AUTHORIZATION='keep-working-2026-11-18';
