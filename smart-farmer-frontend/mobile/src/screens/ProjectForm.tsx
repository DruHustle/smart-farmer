import React, { useRef, useState } from 'react';
import { Text } from 'react-native';
import * as Crypto from 'expo-crypto';
import { label, textFor } from '../i18n';
import { optionalNumber } from '../time';
import { enterpriseTypes, type EnterpriseType, type Language, type Project } from '../types';
import { Button, Choice, Field, Toggle, styles } from '../ui';
import type { Workspace } from '../use-workspace';
import { c, usePanel, farmPath } from '../completion-ui';
import { allPages, string, type Row } from '../product';

export function ProjectForm({ work, language, project, onSaved }: { work: Workspace; language: Language; project?: Project; onSaved: () => void }) {
  const t = textFor(language);
  const clientId = useRef(Crypto.randomUUID());
  const [name, setName] = useState(project?.name || '');
  const [enterprise, setEnterprise] = useState<EnterpriseType>(project?.enterprise_type || 'crop');
  const [crop, setCrop] = useState(project?.crop || '');
  const [irrigation, setIrrigation] = useState(project?.irrigation || false);
  const [plantingDate, setPlantingDate] = useState(project?.planting_date?.slice(0, 10) || '');
  const [variety, setVariety] = useState(project?.variety || '');
  const [area, setArea] = useState(project?.area_ha || '');
  const [stage, setStage] = useState(project?.stage || '');
  const [objective, setObjective] = useState(project?.objective || '');
  const [asOfDate, setAsOfDate] = useState('');
  const [openingCount, setOpeningCount] = useState('');
  const [countBasis, setCountBasis] = useState<'unknown' | 'verified' | 'estimated'>('unknown');
  const [reason, setReason] = useState('');
  const [locationId, setLocationId] = useState(string((project as unknown as Row | undefined)?.location_id));
  const [onboardingMode, setOnboardingMode] = useState('existing');
  const locations = usePanel(work, 'locations', () => allPages<Row>(work.api, farmPath(work, '/locations')));

  async function save() {
    const success = await work.onlineAction(async () => {
      if (!name.trim() || enterprise === 'crop' && !crop.trim() || project && !reason.trim()) throw new Error('required');
      const body: Record<string, unknown> = { name: name.trim(), stage: stage.trim() || null, locationId: locationId || null };
      if (enterprise === 'crop') {
        const size = optionalNumber(area);
        if (size === 0) throw new Error('invalid_number');
        Object.assign(body, { crop: crop.trim(), irrigation, plantingDate: plantingDate || null, variety: variety.trim() || null, objective: objective.trim() || null, areaHa: size });
      }
      if (!project) {
        body.enterpriseType = enterprise;
        body.onboardingMode = onboardingMode;
        body.id = clientId.current;
        if (enterprise !== 'crop' && openingCount.trim()) {
          const count = optionalNumber(openingCount);
          if (count === null || !Number.isInteger(count) || countBasis === 'unknown' || !asOfDate) throw new Error('required');
          Object.assign(body, { openingCount: count, countBasis, asOfDate });
        }
        await work.api.request(`/v1/farms/${work.farmId}/projects`, 'POST', body);
      } else {
        await work.api.request(`/v1/farms/${work.farmId}/projects/${project.id}`, 'PATCH', { ...body, version: project.version, reason: reason.trim() });
      }
    });
    if (success) { onSaved(); await work.refresh(); }
  }

  return <>
    <Text style={styles.muted}>{t.unknownHint}</Text>
    {!project ? <>
      <Button secondary title={t.activeMaize} onPress={() => { setEnterprise('crop'); setName(t.activeMaize); setCrop('maize'); setIrrigation(true); }} />
      <Choice label={t.kind} value={enterprise} onChange={setEnterprise} closeLabel={t.close} options={enterpriseTypes.map(value => ({ value, label: label(language, value) }))} />
    </> : null}
    <Field testID="project-name" label={t.projectName} value={name} onChangeText={setName} maxLength={100} />
    <Choice label={c(language, 'locationId')} value={locationId} onChange={setLocationId} closeLabel={t.close} options={[{ value: '', label: t.unknown }, ...(locations.value || []).map(item => ({ value: string(item.id), label: string(item.name) }))]} />
    {!project ? <Choice label={c(language, 'onboardingMode')} value={onboardingMode} onChange={setOnboardingMode} closeLabel={t.close} options={[{ value: 'new', label: c(language, 'newProject') }, { value: 'existing', label: t.alreadyOperating }]} /> : null}
    {enterprise === 'crop' ? <>
      <Field label={t.crop} value={crop} onChangeText={setCrop} maxLength={80} />
      <Toggle label={t.irrigated} value={irrigation} onChange={setIrrigation} />
      <Field label={t.plantingDate} hint="YYYY-MM-DD" value={plantingDate} onChangeText={setPlantingDate} maxLength={10} />
      <Field label={t.variety} value={variety} onChangeText={setVariety} maxLength={100} />
      <Field label={t.area} value={area} onChangeText={setArea} keyboardType="decimal-pad" />
      <Field label={t.objective} value={objective} onChangeText={setObjective} maxLength={200} />
    </> : !project ? <>
      <Text style={styles.label}>{t.alreadyOperating}</Text>
      <Field label={t.asOfDate} hint="YYYY-MM-DD" value={asOfDate} onChangeText={setAsOfDate} maxLength={10} />
      <Field label={t.openingCount} value={openingCount} onChangeText={setOpeningCount} keyboardType="number-pad" />
      <Choice label={t.countBasis} value={countBasis} onChange={setCountBasis} closeLabel={t.close} options={(['unknown', 'verified', 'estimated'] as const).map(value => ({ value, label: t[value] }))} />
    </> : null}
    <Field label={t.stage} value={stage} onChangeText={setStage} maxLength={100} />
    {project ? <Field label={t.reason} value={reason} onChangeText={setReason} multiline maxLength={2000} /> : null}
    <Button testID="project-save" title={t.save} busy={work.busy} onPress={() => { void save(); }} />
  </>;
}
