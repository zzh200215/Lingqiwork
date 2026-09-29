// API 类型与出口组合（方向 6 第二刀 2026-09-29）：
// - 方法按域住在 src/api/*.ts（第一刀），这里组合成同一个 api 对象；
// - 类型按域拆到 src/api/types/<域>.ts，下面 type-only 转发；
// - 全仓 `import { X } from './api'` 的导入路径全部保持不变。

export { request } from './api/request'
export { streamNotesAi } from './api/notes'

export type { AgentPreset, ArenaResult,
} from './api/types/agents'

export type { BackupItem, BackupList,
} from './api/types/backups'

export type { CardKind, CardGrade, CardDraft, CardSources, CardItem, CardQueue, CardReviewResult,
  CardRetellResult, CardStats, CardSourceStat, CardCrosscheck, CardPrereq,
  CalibrationSegment, CardCalibration, CardContradiction, PrereqAdoption, CardGapRate,
} from './api/types/cards'

export type { MaterialHit,
} from './api/types/common'

export type { Conversation, Message,
} from './api/types/conversations'

export type { DashboardNarrative, DashboardBriefing, DashboardStats, TodayNext, TodaySummaryRow,
  WeeklyReport, SkillLoop, NorthStar, HalfRateWeek, ProcessMetrics,
} from './api/types/dashboard'

export type { BeliefThread, DecisionOutcome, DecisionEntry, CalibrationBucket, Calibration,
  DecisionLogView, DecisionWitness,
} from './api/types/decisions'

export type { EvalItem, EvalCaseResult, EvalRun, TurnFilter, EngineEvalRun, EngineEvalLatest,
  EngineEvalRunResult, TurnSummary, PromptEvalBoard, AgentEvalBoard,
} from './api/types/evals'

export type { HabitKind, Habit, HabitToday, HabitDef,
} from './api/types/habits'

export type { AsrStatus, AsrResult, TtsResult, ImageConfig, ImageItem, ImageGenResult,
} from './api/types/images'

export type { JournalSaved, JournalRecent, CostKindRow, CostSummary, QualityGroup, InjectState,
  QualitySummary,
} from './api/types/journal'

export type { KgStatus, KgRetrieval,
} from './api/types/kg'

export type { MemoryItem, MemoryExpose, MemoryTidyReport, MemoryTidyStatus,
} from './api/types/memories'

export type { SearchHit, NoteSearchHit, NotesChatTurn, VoiceNoteItem, VoicePending,
} from './api/types/notes'

export type { ArtifactsStatus, ArtifactsResult,
} from './api/types/outputs'

export type { PetEvent, PetGrowthPart, PetGrowth, PetPluginPanel, PetPlugin, PetPluginCommandResult,
  PetStateMode, PetState, PetChatMsg, PetThing, PetMeal, PetConceptCard, PetConceptCards,
  PetSkillCard, FormRetrieval, FormConcepts, FormSkill, FormDomain, PetRoom,
} from './api/types/pet'

export type { RoundtableResult, PodcastTurn, PodcastEntry,
} from './api/types/podcast'

export type { PromptItem, PromptVersionItem, PromptUsageItem, PromptView, PromptSort, PromptFacets,
  PromptCategoryItem, PromptTagItem, PromptVarsResult, PromptRegistryEntry, PromptInlineNote,
  PromptCheckSpec, PromptCaseSpec, PromptRegistryEntryDetail, PromptCheckRun,
  PromptCheckReport,
} from './api/types/prompts'

export type { ProviderConfig, McpServer, McpServerStatus, McpActiveTool, McpView, McpProbe, ModelProbe,
  JobHealth, SelfCheck, HealthReport,
} from './api/types/settings'

export type { SkillItem, SkillCandidateResult, SkillCandidateRow, SkillCasesPayload, SkillTrial,
  SkillTrials, SkillEvalReport, FormReport,
} from './api/types/skills'

export type { RepoItem, RepoList, DirItem, DirList, FeedItem, FeedList,
} from './api/types/sources'

export type { DispatchStep, DispatchChain, DispatchBoard, ScheduledTask, TaskTool, TaskRunLogEntry,
  TaskRunItem, TaskRunResult,
} from './api/types/tasks'

export type { ThreadKind, ThreadStep, ThreadCandidate, ThreadItemRow, ThreadRow, ThreadCost,
  ThreadDetail, TurnTrace,
} from './api/types/threads'

export type { TutorEndResult, TutorJudgeResult, InterviewBank, InterviewReportSections,
  InterviewReportResult, TutorSessionStart, TutorTurn, TutorProfile, TutorStuckRow,
  TutorConceptRow, CardsSummary, TutorDigestPoint, TutorDigestResult, TutorUntouchedPoint,
  TutorLearningMap, TutorMasteryEvent, TutorMastery, TutorNeighbor, TutorSessionRow,
  TutorDetail, TutorStats, TutorStarter, SessionVerdictSide, SessionCalibration,
} from './api/types/tutor'

export type { UsageFeatureRow,
} from './api/types/usage'

export type { WorkOutput, DeliverOption, DeliverGenre, DeliverTemplate, DeliverCatalogue, DeliverOutline,
  WorkMeeting, DeliverWitness,
} from './api/types/work'

// 方向 6 第一刀（2026-09-28）：api 对象按域拆到 src/api/，这里组合成同一个对象——
// 全仓 `import { api } from './api'` 的导入路径不变；类型已挪到 src/api/types/，由本文件转发。
import { agentsApi } from './api/agents'
import { backupsApi } from './api/backups'
import { cardsApi } from './api/cards'
import { conversationsApi } from './api/conversations'
import { dashboardApi } from './api/dashboard'
import { decisionsApi } from './api/decisions'
import { evalsApi } from './api/evals'
import { habitsApi } from './api/habits'
import { imagesApi } from './api/images'
import { journalApi } from './api/journal'
import { kbApi } from './api/kb'
import { kgApi } from './api/kg'
import { memoriesApi } from './api/memories'
import { notesApi } from './api/notes'
import { outputsApi } from './api/outputs'
import { petApi } from './api/pet'
import { podcastApi } from './api/podcast'
import { promptsApi } from './api/prompts'
import { settingsApi } from './api/settings'
import { skillsApi } from './api/skills'
import { sourcesApi } from './api/sources'
import { tasksApi } from './api/tasks'
import { threadsApi } from './api/threads'
import { tutorApi } from './api/tutor'
import { usageApi } from './api/usage'
import { workApi } from './api/work'

export const api = {
  ...agentsApi,
  ...backupsApi,
  ...cardsApi,
  ...conversationsApi,
  ...dashboardApi,
  ...decisionsApi,
  ...evalsApi,
  ...habitsApi,
  ...imagesApi,
  ...journalApi,
  ...kbApi,
  ...kgApi,
  ...memoriesApi,
  ...notesApi,
  ...outputsApi,
  ...petApi,
  ...podcastApi,
  ...promptsApi,
  ...settingsApi,
  ...skillsApi,
  ...sourcesApi,
  ...tasksApi,
  ...threadsApi,
  ...tutorApi,
  ...usageApi,
  ...workApi,
}
