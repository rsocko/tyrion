import {
  KID_ATTRIBUTION_ENGINE_VERSION,
  PolicyService,
  ReattributionService,
  TYRION_DOMAIN_CONTRACT_VERSION,
  attributeTransactionV1,
  createAttributionInputsFromBridgePageV1,
} from '@rsocko/tyrion-kid-engine';
import * as publicApi from '@rsocko/tyrion-kid-engine';
import {
  parseAttributionInputV1,
  parsePolicySnapshotV1,
} from '@rsocko/tyrion-kid-engine/contracts/v1';
import {
  FilePolicyRepository,
  authorizeReattribution,
} from '@rsocko/tyrion-kid-engine/policy';

const exportsToVerify = [
  KID_ATTRIBUTION_ENGINE_VERSION,
  TYRION_DOMAIN_CONTRACT_VERSION,
  PolicyService,
  ReattributionService,
  attributeTransactionV1,
  createAttributionInputsFromBridgePageV1,
  parseAttributionInputV1,
  parsePolicySnapshotV1,
  FilePolicyRepository,
  authorizeReattribution,
];

if (exportsToVerify.some((value) => value === undefined)) {
  throw new Error('Published Tyrion kid-engine exports are incomplete');
}

for (const unsupportedLegacyExport of [
  'attributeTransaction',
  'matchCardRules',
  'checkThresholds',
  'generateSuggestions',
]) {
  if (unsupportedLegacyExport in publicApi) {
    throw new Error(`Unsupported legacy export is public: ${unsupportedLegacyExport}`);
  }
}
