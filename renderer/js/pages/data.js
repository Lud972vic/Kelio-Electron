'use strict';

const DataPage = (() => {
  const PAGE_SIZE = 10;
  let _activeTab = 'employees';
  let _page = 1;
  let _filters = {};

  const TABS = [
    { key: 'employees',           label: 'Salariés',            icon: '👤', kelioLabel: 'Salariés', webService: 'EmployeeService', help: 'Liste des salariés importés depuis Kelio avec leurs informations personnelles, matricule, badge, section et dates de validité. Service Kelio : EmployeeService (exportEmployeesList).' },
    { key: 'clockings',           label: 'Badgeages',           icon: '⏱', kelioLabel: 'Badgeages', webService: 'ClockingService', help: 'Pointages entrée/sortie des salariés avec date, heure, terminal et lecteur. Permet de vérifier la présence et les horaires réels. Service Kelio : ClockingService (exportClockingsList).' },
    { key: 'absence-files',       label: 'Fiches absence',      icon: '📋', kelioLabel: 'Fiches d\'absence', webService: 'AbsenceFileService', help: 'Absences validées (traitées) avec type, dates, durée et statut. Représente les absences effectivement prises en compte. Service Kelio : AbsenceFileService (exportAbsenceFilesList).' },
    { key: 'absence-requests',    label: 'Demandes absence',    icon: '📝', kelioLabel: 'Demandes d\'absence', webService: 'AbsenceRequestService', help: 'Demandes d\'absence en attente ou traitées. Différent des fiches : une demande peut encore être en attente de validation. Service Kelio : AbsenceRequestService (exportAbsenceRequestsList).' },
    { key: 'schedules',           label: 'Horaires',            icon: '📅', kelioLabel: 'Horaires et périodes de travail', webService: 'DailyScheduleAssignmentService', help: 'Affectations d\'horaires théoriques jour par jour. Indique quel planning était appliqué chaque jour pour chaque salarié. Service Kelio : DailyScheduleAssignmentService (exportDailyScheduleAssignmentsList).' },
    { key: 'job-assignments',     label: 'Activités',           icon: '🏷', kelioLabel: 'Affectations activité', webService: 'JobAssignmentService', help: 'Affectations aux activités/postes (jobs). Permet de savoir sur quelle tâche le salarié travaillait chaque jour. Service Kelio : JobAssignmentService (exportComputedJobAssignmentsList).' },
    { key: 'section-assignments', label: 'Services jour/jour',  icon: '📌', kelioLabel: 'Affectations service jour/jour', webService: 'SectionAssignmentDayPerDayService', help: 'Affectations aux services jour par jour. Permet de suivre les changements d\'affectation service dans le temps. Service Kelio : SectionAssignmentDayPerDayService (exportSectionAssignmentsDayPerDayList).' },
    { key: 'organization',        label: 'Organigramme',        icon: '🏢', kelioLabel: 'Organigramme', webService: 'OrganizationService', help: 'Structure de l\'entreprise avec niveaux et sections. Utilisé pour l\'organisation hiérarchique et les filtres de population. Service Kelio : OrganizationService (exportOrganizationList).' },
  ];

  async function render(container) {
    const today    = '2024-12-31';
    const firstDay = '2024-01-01';

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Données importées</div>
          <div class="page-subtitle">Badgeages, absences, horaires, activités, organigramme</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm" id="btnDataHelp" title="Comprendre les données">❓ Aide</button>
          <button class="btn btn-ghost btn-sm" id="btnDataExport">↓ Export CSV</button>
        </div>
      </div>

      <div class="card" style="padding:0;">
        <div class="tab-bar" id="tabBar">
          ${TABS.map(t => `
            <button class="tab-btn${t.key === _activeTab ? ' active' : ''}" data-tab="${Utils.esc(t.key)}" title="${Utils.esc(t.kelioLabel)} | Service: ${Utils.esc(t.webService)}&#10;&#10;${Utils.esc(t.help)}">
              ${t.icon} ${Utils.esc(t.label)}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="card" id="dataFilters"></div>
      <div class="card" id="dataTableWrap">
        <div style="padding:24px;text-align:center;"><span class="spinner"></span></div>
      </div>
      <div class="pagination" id="dataPagination"></div>
    `;

    document.getElementById('tabBar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      _activeTab = btn.dataset.tab;
      _page = 1;
      _filters = {};
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _renderFilters(today, firstDay);
      _load();
    });

    document.getElementById('btnDataHelp').addEventListener('click', _showHelp);
    document.getElementById('btnDataExport').addEventListener('click', _export);

    _renderFilters(today, firstDay);
    await _load();
  }

  function _renderFilters(today, firstDay) {
    const wrap = document.getElementById('dataFilters');
    const tab  = _activeTab;
    const isOrg = tab === 'organization';
    const isEmp = tab === 'employees';
    const needsDates = !isOrg && !isEmp;

    wrap.innerHTML = `
      <div class="filters-bar" style="flex-wrap:wrap;gap:12px;">
        ${isEmp ? `
          <div class="form-group">
            <label class="form-label">Recherche</label>
            <input type="text" class="form-control" id="dfQ" placeholder="Nom, prénom, matricule, clé…" style="max-width:260px;" />
          </div>
          <div class="form-group">
            <label class="form-label">Archivés</label>
            <select class="form-control" id="dfArchived" style="max-width:150px;">
              <option value="">Tous</option>
              <option value="0">Actifs seulement</option>
              <option value="1">Archivés seulement</option>
            </select>
          </div>
        ` : isOrg ? `
          <div class="form-group">
            <label class="form-label">Recherche</label>
            <input type="text" class="form-control" id="dfQ" placeholder="Code, description…" style="max-width:240px;" />
          </div>
          <div class="form-group">
            <label class="form-label">Statut</label>
            <select class="form-control" id="dfActive" style="max-width:160px;">
              <option value="">Tous</option>
              <option value="1">Actifs</option>
              <option value="0">Inactifs</option>
            </select>
          </div>
        ` : `
          <div class="form-group">
            <label class="form-label">Salarié</label>
            <input type="text" class="form-control" id="dfEmployee" placeholder="Clé salarié…" style="max-width:200px;" />
          </div>
          ${needsDates ? `
          <div class="form-group">
            <label class="form-label">Date début</label>
            <input type="date" class="form-control" id="dfFrom" value="${firstDay}" style="max-width:155px;" />
          </div>
          <div class="form-group">
            <label class="form-label">Date fin</label>
            <input type="date" class="form-control" id="dfTo" value="${today}" style="max-width:155px;" />
          </div>` : ''}
          ${(tab === 'clockings') ? `
          <div class="form-group">
            <label class="form-label">Direction</label>
            <select class="form-control" id="dfDirection" style="max-width:160px;">
              <option value="">Toutes</option>
              <option value="IN">Entrée (IN)</option>
              <option value="OUT">Sortie (OUT)</option>
            </select>
          </div>` : ''}
          ${(tab === 'absence-files' || tab === 'absence-requests') ? `
          <div class="form-group">
            <label class="form-label">Type absence</label>
            <input type="text" class="form-control" id="dfTypeKey" placeholder="ex: CONGES" style="max-width:160px;" />
          </div>` : ''}
        `}
        <button class="btn btn-ghost btn-sm" id="btnDataSearch" style="margin-top:18px;">🔍 Filtrer</button>
        <button class="btn btn-ghost btn-sm" id="btnDataReset"  style="margin-top:18px;">↺ Réinitialiser</button>
      </div>
    `;

    document.getElementById('btnDataSearch').addEventListener('click', () => {
      _page = 1;
      _readFilters();
      _load();
    });
    document.getElementById('btnDataReset').addEventListener('click', () => {
      _page = 1;
      _filters = {};
      wrap.querySelectorAll('input').forEach(i => {
        if (i.type === 'date') {
          i.value = i.id === 'dfFrom' ? firstDay : today;
        } else {
          i.value = '';
        }
      });
      wrap.querySelectorAll('select').forEach(s => s.value = '');
      _load();
    });
  }

  function _readFilters() {
    _filters = {};
    const emp  = document.getElementById('dfEmployee');
    const from = document.getElementById('dfFrom');
    const to   = document.getElementById('dfTo');
    const dir  = document.getElementById('dfDirection');
    const tk   = document.getElementById('dfTypeKey');
    const q    = document.getElementById('dfQ');
    const act  = document.getElementById('dfActive');
    const arch = document.getElementById('dfArchived');
    if (emp  && emp.value.trim())  _filters.employee  = emp.value.trim();
    if (from && from.value)        _filters.date_from = from.value;
    if (to   && to.value)          _filters.date_to   = to.value;
    if (dir  && dir.value)         _filters.direction = dir.value;
    if (tk   && tk.value.trim())   _filters.type_key  = tk.value.trim();
    if (q    && q.value.trim())    _filters.q         = q.value.trim();
    if (act  && act.value !== '')  _filters.active    = act.value === '1';
    if (arch && arch.value !== '') _filters.archived  = arch.value === '1';
  }

  async function _load() {
    const wrap = document.getElementById('dataTableWrap');
    wrap.innerHTML = '<div style="padding:24px;text-align:center;"><span class="spinner"></span></div>';

    try {
      const f = { ..._filters, limit: PAGE_SIZE, offset: (_page - 1) * PAGE_SIZE };
      let rows = [];

      switch (_activeTab) {
        case 'employees':            rows = await window.KelioAPI.employeesList(f);            break;
        case 'clockings':           rows = await window.KelioAPI.clockingsList(f);           break;
        case 'absence-files':        rows = await window.KelioAPI.absenceFilesList(f);        break;
        case 'absence-requests':     rows = await window.KelioAPI.absenceRequestsList(f);     break;
        case 'schedules':            rows = await window.KelioAPI.schedulesList(f);           break;
        case 'job-assignments':      rows = await window.KelioAPI.jobAssignmentsList(f);      break;
        case 'section-assignments':  rows = await window.KelioAPI.sectionAssignmentsList(f);  break;
        case 'organization':         rows = await window.KelioAPI.organizationList(f);        break;
      }

      if (!rows || rows.length === 0) {
        wrap.innerHTML = Utils.emptyState('○', 'Aucune donnée — lancez une extraction depuis la page Extraction');
        document.getElementById('dataPagination').innerHTML = '';
        return;
      }

      wrap.innerHTML = `<div class="table-wrapper">${_buildTable(rows)}</div>`;

      Utils.buildPagination(document.getElementById('dataPagination'), {
        page: _page,
        totalPages: rows.length === PAGE_SIZE ? _page + 1 : _page,
        onChange: (p) => { _page = p; _load(); },
      });
    } catch (e) {
      wrap.innerHTML = Utils.emptyState('✕', `Erreur: ${Utils.esc(e.message)}`);
    }
  }

  function _buildTable(rows) {
    switch (_activeTab) {
      case 'employees':            return _tableEmployees(rows);
      case 'clockings':           return _tableClockings(rows);
      case 'absence-files':        return _tableAbsences(rows, false);
      case 'absence-requests':     return _tableAbsences(rows, true);
      case 'schedules':            return _tableSchedules(rows);
      case 'job-assignments':      return _tableJobAssignments(rows);
      case 'section-assignments':  return _tableSectionAssignments(rows);
      case 'organization':         return _tableOrganization(rows);
      default: return '';
    }
  }

  function _tableEmployees(rows) {
    return `<table>
      <thead><tr>
        <th>archivedEmployee</th><th>currentAccessAuthorizationEndDate</th><th>currentAccessAuthorizationEndTime</th>
        <th>currentAccessAuthorizationStartDate</th><th>currentAccessAuthorizationStartTime</th>
        <th>defaultEmployeeBadge</th><th>defaultEmployeeFirstName</th><th>defaultEmployeeIdentificationCode</th><th>defaultEmployeeIdentificationNumber</th><th>defaultEmployeeSurname</th>
        <th>employeeBadgeCode</th><th>employeeFirstName</th><th>employeeIdentificationCode</th><th>employeeIdentificationNumber</th><th>employeeKey</th><th>employeeSurname</th>
        <th>errorMessage</th>
        <th>generateBadge</th><th>isAccessModuleEmployee</th><th>isTandAModuleEmployee</th><th>searchUsingBadge</th><th>searchUsingFirstname</th><th>searchUsingIdentificationNumber</th><th>searchUsingSurname</th>
        <th>takenIntoAccountEndDate</th><th>takenIntoAccountPeriodEndDate</th><th>takenIntoAccountPeriodStartDate</th><th>takenIntoAccountStartDate</th>
        <th>populationEndDate</th><th>populationFilter</th><th>populationMode</th><th>populationStartDate</th>
        <th>technicalString</th><th>useDefaultModelEmployee</th><th>userProfileAssignmentWizardDescription</th><th>userProfileAssignmentWizardKey</th><th>imported_at</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${r.archived_employee ? 'Oui' : 'Non'}</td>
        <td class="td-muted">${Utils.fmtDate(r.current_access_authorization_end_date)}</td>
        <td class="td-muted">${Utils.fmt(r.current_access_authorization_end_time)}</td>
        <td class="td-muted">${Utils.fmtDate(r.current_access_authorization_start_date)}</td>
        <td class="td-muted">${Utils.fmt(r.current_access_authorization_start_time)}</td>
        <td>${Utils.fmt(r.default_employee_badge)}</td>
        <td>${Utils.fmt(r.default_employee_first_name)}</td>
        <td>${Utils.fmt(r.default_employee_identification_code)}</td>
        <td>${Utils.fmt(r.default_employee_identification_number)}</td>
        <td>${Utils.fmt(r.default_employee_surname)}</td>
        <td class="td-mono">${Utils.fmt(r.employee_badge_code)}</td>
        <td>${Utils.fmt(r.employee_first_name)}</td>
        <td>${Utils.fmt(r.employee_identification_code)}</td>
        <td>${Utils.fmt(r.employee_identification_number)}</td>
        <td class="td-mono">${Utils.fmt(r.employee_key)}</td>
        <td><strong>${Utils.fmt(r.employee_surname)}</strong></td>
        <td class="td-error">${Utils.fmt(r.error_message)}</td>
        <td>${r.generate_badge ? 'Oui' : 'Non'}</td>
        <td>${r.is_access_module_employee ? 'Oui' : 'Non'}</td>
        <td>${r.is_tanda_module_employee ? 'Oui' : 'Non'}</td>
        <td>${r.search_using_badge ? 'Oui' : 'Non'}</td>
        <td>${r.search_using_firstname ? 'Oui' : 'Non'}</td>
        <td>${r.search_using_identification_number ? 'Oui' : 'Non'}</td>
        <td>${r.search_using_surname ? 'Oui' : 'Non'}</td>
        <td class="td-muted">${Utils.fmtDate(r.taken_into_account_end_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.taken_into_account_period_end_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.taken_into_account_period_start_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.taken_into_account_start_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.population_end_date)}</td>
        <td>${Utils.fmt(r.population_filter)}</td>
        <td class="td-muted">${Utils.fmt(r.population_mode)}</td>
        <td class="td-muted">${Utils.fmtDate(r.population_start_date)}</td>
        <td class="td-mono td-muted">${Utils.fmt(r.technical_string)}</td>
        <td>${r.use_default_model_employee ? 'Oui' : 'Non'}</td>
        <td>${Utils.fmt(r.user_profile_assignment_wizard_description)}</td>
        <td class="td-mono">${Utils.fmt(r.user_profile_assignment_wizard_key)}</td>
        <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function _tableClockings(rows) {
    return `<table>
      <thead><tr>
        <th>absenceTypeAbbreviation</th><th>absenceTypeDescription</th><th>absenceTypeKey</th>
        <th>archivedEmployee</th><th>automatic</th><th>clockingKey</th><th>clockingTypeIndicator</th>
        <th>date</th><th>employeeBadgeCode</th><th>employeeFirstName</th><th>employeeIdentificationCode</th><th>employeeIdentificationNumber</th><th>employeeKey</th><th>employeeSurname</th>
        <th>errorMessage</th><th>geolocationPrecision</th><th>geolocationStatus</th><th>inOutIndicator</th>
        <th>latitude</th><th>longitude</th><th>obtainingMode</th>
        <th>overtimeTypeAbbreviation</th><th>overtimeTypeDescription</th><th>overtimeTypeKey</th>
        <th>readerDescription</th><th>readerKey</th><th>technicalString</th>
        <th>terminalDescription</th><th>terminalKey</th><th>time</th><th>timePosition</th><th>imported_at</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${Utils.fmt(r.absence_type_abbreviation)}</td>
        <td>${Utils.fmt(r.absence_type_description)}</td>
        <td class="td-mono">${Utils.fmt(r.absence_type_key)}</td>
        <td>${r.archived_employee ? 'Oui' : 'Non'}</td>
        <td>${r.automatic ? 'Oui' : 'Non'}</td>
        <td class="td-mono">${Utils.fmt(r.badge_code)}</td>
        <td class="td-muted">${Utils.fmt(r.clocking_type_indicator)}</td>
        <td>${Utils.fmtDate(r.clocking_date)}</td>
        <td class="td-mono">${Utils.fmt(r.employee_badge_code)}</td>
        <td>${Utils.fmt(r.employee_first_name)}</td>
        <td>${Utils.fmt(r.employee_identification_code)}</td>
        <td>${Utils.fmt(r.employee_identification_number)}</td>
        <td class="td-mono">${Utils.fmt(r.employee_key)}</td>
        <td><strong>${Utils.fmt(r.employee_surname)}</strong></td>
        <td class="td-error">${Utils.fmt(r.error_message)}</td>
        <td class="td-muted">${Utils.fmt(r.geolocation_precision)}</td>
        <td class="td-muted">${Utils.fmt(r.geolocation_status)}</td>
        <td>${_dirBadge(r.direction_code)}</td>
        <td class="td-muted">${Utils.fmt(r.latitude)}</td>
        <td class="td-muted">${Utils.fmt(r.longitude)}</td>
        <td class="td-muted">${Utils.fmt(r.obtaining_mode)}</td>
        <td>${Utils.fmt(r.overtime_type_abbreviation)}</td>
        <td>${Utils.fmt(r.overtime_type_description)}</td>
        <td class="td-mono">${Utils.fmt(r.overtime_type_key)}</td>
        <td>${Utils.fmt(r.reader_description)}</td>
        <td class="td-mono">${Utils.fmt(r.reader_code)}</td>
        <td class="td-mono td-muted">${Utils.fmt(r.technical_string)}</td>
        <td>${Utils.fmt(r.terminal_description)}</td>
        <td class="td-mono">${Utils.fmt(r.terminal_code)}</td>
        <td>${Utils.fmt(r.clocking_datetime ? r.clocking_datetime.slice(11,16) : '')}</td>
        <td class="td-muted">${Utils.fmt(r.time_position)}</td>
        <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function _absenceStatusLabel(code) {
    const map = { '1': 'En cours', '2': 'Validée', '3': 'Refusée', '4': 'Annulée', '5': 'En attente', 'ACCEPTED': 'Validée', 'REFUSED': 'Refusée', 'PENDING': 'En attente', 'CANCELLED': 'Annulée' };
    const label = map[String(code)] ?? (code ? String(code) : null);
    if (!label) return '<span class="td-muted">—</span>';
    const colors = { 'Validée': 'var(--color-success)', 'Refusée': 'var(--color-danger)', 'En attente': 'var(--color-warning)', 'Annulée': 'var(--color-muted)' };
    const color = colors[label] ?? 'inherit';
    return `<span style="color:${color};font-weight:600;">${Utils.esc(label)}</span>`;
  }

  function _tableAbsences(rows, isRequest) {
    if (isRequest) {
      // Pour les demandes d'absence, afficher tous les champs de la documentation Kelio
      return `<table>
      <thead><tr>
        <th>absenceFileKey</th><th>absenceRequestKey</th><th>absenceTypeAbbreviation</th><th>absenceTypeDescription</th><th>absenceTypeKey</th>
        <th>archivedEmployee</th><th>comment</th><th>creationDate</th><th>durationInDays</th><th>durationInHours</th>
        <th>employeeBadgeCode</th><th>employeeFirstName</th><th>employeeIdentificationCode</th><th>employeeIdentificationNumber</th><th>employeeKey</th><th>employeeSurname</th>
        <th>endingTheAfternoon</th><th>errorMessage</th>
        <th>firstEndTime</th><th>firstEndTimePosition</th><th>firstStartTime</th><th>firstStartTimePosition</th>
        <th>lastModificationDate</th><th>requestState</th><th>requestType</th>
        <th>secondEndTime</th><th>secondEndTimePosition</th><th>secondStartTime</th><th>secondStartTimePosition</th>
        <th>splitHolidaysWaiver</th><th>startDate</th><th>startInTheMorning</th>
        <th>technicalString</th><th>totalInDays</th><th>totalInHours</th><th>endDate</th><th>imported_at</th>
        <th>validatorsBadgeCodes</th><th>validatorsFirstNames</th><th>validatorsIdentificationCode</th><th>validatorsIdentificationNumbers</th><th>validatorsKeys</th><th>validatorsLogins</th><th>validatorsSurnames</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="td-mono">${Utils.fmt(r.absence_file_key)}</td>
        <td class="td-mono">${Utils.fmt(r.request_key)}</td>
        <td>${Utils.fmt(r.absence_type_abbreviation)}</td>
        <td>${Utils.fmt(r.type_description)}</td>
        <td class="td-mono">${Utils.fmt(r.type_key)}</td>
        <td>${r.archived_employee ? 'Oui' : 'Non'}</td>
        <td class="td-muted">${Utils.fmt(r.comment)}</td>
        <td class="td-muted">${Utils.fmtDate(r.creation_date)}</td>
        <td style="text-align:right;">${r.duration_days != null ? Number(r.duration_days).toFixed(1) : '—'}</td>
        <td style="text-align:right;">${r.duration_in_hours != null ? Number(r.duration_in_hours).toFixed(1) : '—'}</td>
        <td class="td-mono">${Utils.fmt(r.employee_badge_code)}</td>
        <td>${Utils.fmt(r.employee_first_name)}</td>
        <td>${Utils.fmt(r.employee_identification_code)}</td>
        <td>${Utils.fmt(r.employee_identification_number)}</td>
        <td class="td-mono">${Utils.fmt(r.employee_key)}</td>
        <td><strong>${Utils.fmt(r.employee_surname)}</strong></td>
        <td>${r.ending_the_afternoon ? 'Oui' : 'Non'}</td>
        <td class="td-error">${Utils.fmt(r.error_message)}</td>
        <td class="td-muted">${Utils.fmt(r.first_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.first_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.first_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.first_start_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.last_modification_date)}</td>
        <td>${_absenceStatusLabel(r.status_code)}</td>
        <td class="td-muted">${Utils.fmt(r.request_type)}</td>
        <td class="td-muted">${Utils.fmt(r.second_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.second_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.second_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.second_start_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.split_holidays_waiver)}</td>
        <td>${Utils.fmtDate(r.start_date)}</td>
        <td>${r.start_in_the_morning ? 'Oui' : 'Non'}</td>
        <td class="td-mono td-muted">${Utils.fmt(r.technical_string)}</td>
        <td style="text-align:right;">${r.total_in_days != null ? Number(r.total_in_days).toFixed(1) : '—'}</td>
        <td style="text-align:right;">${r.total_in_hours != null ? Number(r.total_in_hours).toFixed(1) : '—'}</td>
        <td>${Utils.fmtDate(r.end_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
        <td class="td-muted">${Utils.fmt(r.validators_badge_codes)}</td>
        <td class="td-muted">${Utils.fmt(r.validators_first_names)}</td>
        <td class="td-muted">${Utils.fmt(r.validators_identification_code)}</td>
        <td class="td-muted">${Utils.fmt(r.validators_identification_numbers)}</td>
        <td class="td-muted">${Utils.fmt(r.validators_keys)}</td>
        <td class="td-muted">${Utils.fmt(r.validators_logins)}</td>
        <td class="td-muted">${Utils.fmt(r.validators_surnames)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
    }
    // Pour les fiches d'absence, afficher tous les champs de la documentation Kelio
    return `<table>
      <thead><tr>
        <th>absenceFileKey</th><th>absenceTypeAbbreviation</th><th>absenceTypeDescription</th><th>absenceTypeKey</th>
        <th>archivedEmployee</th><th>comment</th><th>creationDate</th><th>durationInDays</th><th>durationInHours</th>
        <th>employeeBadgeCode</th><th>employeeFirstName</th><th>employeeIdentificationCode</th><th>employeeIdentificationNumber</th><th>employeeKey</th><th>employeeSurname</th>
        <th>endingTheAfternoon</th><th>errorMessage</th><th>eventObservingDate</th><th>existRelatedDocument</th>
        <th>firstEndTime</th><th>firstEndTimePosition</th><th>firstStartTime</th><th>firstStartTimePosition</th>
        <th>initialNoticeCessationWorkDate</th><th>lastModificationDate</th><th>lastWorkingDayDate</th>
        <th>limitedToAPeriod</th><th>noticeCessationWorkExtension</th><th>numberOfAbsenceDays</th><th>prescribedEndDate</th>
        <th>repetitiveAbsencePeriod</th><th>resumptionWorkDate</th><th>resumptionWorkEarlyDate</th>
        <th>secondEndTime</th><th>secondEndTimePosition</th><th>secondStartTime</th><th>secondStartTimePosition</th>
        <th>splitHolidaysWaiver</th><th>startDate</th><th>startInTheMorning</th><th>statusCode</th>
        <th>technicalString</th><th>totalInDays</th><th>totalInHours</th><th>endDate</th><th>imported_at</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="td-mono">${Utils.fmt(r.file_key)}</td>
        <td>${Utils.fmt(r.type_abbreviation)}</td>
        <td>${Utils.fmt(r.type_description)}</td>
        <td class="td-mono">${Utils.fmt(r.type_key)}</td>
        <td>${r.archived_employee ? 'Oui' : 'Non'}</td>
        <td class="td-muted">${Utils.fmt(r.comment)}</td>
        <td class="td-muted">${Utils.fmtDate(r.creation_date)}</td>
        <td style="text-align:right;">${r.duration_days != null ? Number(r.duration_days).toFixed(1) : '—'}</td>
        <td style="text-align:right;">${r.duration_in_hours != null ? Number(r.duration_in_hours).toFixed(1) : '—'}</td>
        <td class="td-mono">${Utils.fmt(r.employee_badge_code)}</td>
        <td>${Utils.fmt(r.employee_first_name)}</td>
        <td>${Utils.fmt(r.employee_identification_code)}</td>
        <td>${Utils.fmt(r.employee_identification_number)}</td>
        <td class="td-mono">${Utils.fmt(r.employee_key)}</td>
        <td><strong>${Utils.fmt(r.employee_surname)}</strong></td>
        <td>${r.ending_the_afternoon ? 'Oui' : 'Non'}</td>
        <td class="td-error">${Utils.fmt(r.error_message)}</td>
        <td class="td-muted">${Utils.fmtDate(r.event_observing_date)}</td>
        <td>${r.exist_related_document ? 'Oui' : 'Non'}</td>
        <td class="td-muted">${Utils.fmt(r.first_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.first_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.first_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.first_start_time_position)}</td>
        <td class="td-muted">${Utils.fmtDate(r.initial_notice_cessation_work_date)}</td>
        <td class="td-muted">${Utils.fmt(r.last_modification_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.last_working_day_date)}</td>
        <td>${r.limited_to_a_period ? 'Oui' : 'Non'}</td>
        <td>${r.notice_cessation_work_extension ? 'Oui' : 'Non'}</td>
        <td class="td-muted">${Utils.fmt(r.number_of_absence_days)}</td>
        <td class="td-muted">${Utils.fmtDate(r.prescribed_end_date)}</td>
        <td class="td-muted">${Utils.fmt(r.repetitive_absence_period)}</td>
        <td class="td-muted">${Utils.fmtDate(r.resumption_work_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.resumption_work_early_date)}</td>
        <td class="td-muted">${Utils.fmt(r.second_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.second_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.second_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.second_start_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.split_holidays_waiver)}</td>
        <td>${Utils.fmtDate(r.start_date)}</td>
        <td>${r.start_in_the_morning ? 'Oui' : 'Non'}</td>
        <td>${_absenceStatusLabel(r.status_code)}</td>
        <td class="td-mono td-muted">${Utils.fmt(r.technical_string)}</td>
        <td style="text-align:right;">${r.total_in_days != null ? Number(r.total_in_days).toFixed(1) : '—'}</td>
        <td style="text-align:right;">${r.total_in_hours != null ? Number(r.total_in_hours).toFixed(1) : '—'}</td>
        <td>${Utils.fmtDate(r.end_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function _tableSchedules(rows) {
    return `<table>
      <thead><tr>
        <th>assignmentDate</th><th>dailyScheduleAbbreviation</th><th>dailyScheduleDescription</th><th>dailyScheduleKey</th>
        <th>scheduleAbbreviation</th><th>scheduleDescription</th>
        <th>afternoonContractedTime</th><th>archivedEmployee</th><th>assignementByException</th>
        <th>calculationModeContractedSchedule</th><th>comment</th><th>contractedTime</th>
        <th>employeeBadgeCode</th><th>employeeFirstName</th><th>employeeIdentificationCode</th><th>employeeIdentificationNumber</th><th>employeeKey</th><th>employeeSurname</th>
        <th>errorMessage</th>
        <th>fifthWorkingPeriodEndTime</th><th>fifthWorkingPeriodEndTimePosition</th><th>fifthWorkingPeriodStartTime</th><th>fifthWorkingPeriodStartTimePosition</th>
        <th>firstWorkingPeriodEndTime</th><th>firstWorkingPeriodEndTimePosition</th><th>firstWorkingPeriodStartTime</th><th>firstWorkingPeriodStartTimePosition</th>
        <th>fourthWorkingPeriodEndTime</th><th>fourthWorkingPeriodEndTimePosition</th><th>fourthWorkingPeriodStartTime</th><th>fourthWorkingPeriodStartTimePosition</th>
        <th>halfDayTime</th><th>morningContractedTime</th><th>nightStartTime</th><th>nightStartTimePosition</th>
        <th>secondWorkingPeriodEndTime</th><th>secondWorkingPeriodEndTimePosition</th><th>secondWorkingPeriodStartTime</th><th>secondWorkingPeriodStartTimePosition</th>
        <th>technicalString</th>
        <th>thirdWorkingPeriodEndTime</th><th>thirdWorkingPeriodEndTimePosition</th><th>thirdWorkingPeriodStartTime</th><th>thirdWorkingPeriodStartTimePosition</th>
        <th>imported_at</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${Utils.fmtDate(r.start_date)}</td>
        <td>${Utils.fmt(r.schedule_code)}</td>
        <td>${Utils.fmt(r.schedule_description)}</td>
        <td class="td-mono">${Utils.fmt(r.schedule_key)}</td>
        <td>${Utils.fmt(r.schedule_abbreviation)}</td>
        <td>${Utils.fmt(r.schedule_description)}</td>
        <td style="text-align:right;">${r.afternoon_contracted_time != null ? Number(r.afternoon_contracted_time).toFixed(1) : '—'}</td>
        <td>${r.archived_employee ? 'Oui' : 'Non'}</td>
        <td>${r.assignement_by_exception ? 'Oui' : 'Non'}</td>
        <td class="td-muted">${Utils.fmt(r.calculation_mode_contracted_schedule)}</td>
        <td class="td-muted">${Utils.fmt(r.comment)}</td>
        <td style="text-align:right;">${r.contracted_time != null ? Number(r.contracted_time).toFixed(1) : '—'}</td>
        <td class="td-mono">${Utils.fmt(r.employee_badge_code)}</td>
        <td>${Utils.fmt(r.employee_first_name)}</td>
        <td>${Utils.fmt(r.employee_identification_code)}</td>
        <td>${Utils.fmt(r.employee_identification_number)}</td>
        <td class="td-mono">${Utils.fmt(r.employee_key)}</td>
        <td><strong>${Utils.fmt(r.employee_surname)}</strong></td>
        <td class="td-error">${Utils.fmt(r.error_message)}</td>
        <td class="td-muted">${Utils.fmt(r.fifth_working_period_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.fifth_working_period_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.fifth_working_period_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.fifth_working_period_start_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.first_working_period_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.first_working_period_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.first_working_period_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.first_working_period_start_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.fourth_working_period_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.fourth_working_period_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.fourth_working_period_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.fourth_working_period_start_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.half_day_time)}</td>
        <td style="text-align:right;">${r.morning_contracted_time != null ? Number(r.morning_contracted_time).toFixed(1) : '—'}</td>
        <td class="td-muted">${Utils.fmt(r.night_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.night_start_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.second_working_period_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.second_working_period_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.second_working_period_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.second_working_period_start_time_position)}</td>
        <td class="td-mono td-muted">${Utils.fmt(r.technical_string)}</td>
        <td class="td-muted">${Utils.fmt(r.third_working_period_end_time)}</td>
        <td class="td-muted">${Utils.fmt(r.third_working_period_end_time_position)}</td>
        <td class="td-muted">${Utils.fmt(r.third_working_period_start_time)}</td>
        <td class="td-muted">${Utils.fmt(r.third_working_period_start_time_position)}</td>
        <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function _tableJobAssignments(rows) {
    return `<table>
      <thead><tr>
        <th>jobKey</th><th>jobCode</th><th>jobDescription</th>
        <th>assignmentDate</th><th>employeeBadgeCode</th><th>employeeFirstName</th>
        <th>employeeIdentificationCode</th><th>employeeIdentificationNumber</th><th>employeeSurname</th>
        <th>archivedEmployee</th><th>errorMessage</th><th>technicalString</th><th>importedAt</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="td-mono">${Utils.fmt(r.jobKey)}</td>
        <td>${Utils.fmt(r.jobCode)}</td>
        <td>${Utils.fmt(r.jobDescription)}</td>
        <td>${Utils.fmtDate(r.assignmentDate)}</td>
        <td class="td-mono">${Utils.fmt(r.employeeBadgeCode)}</td>
        <td>${Utils.fmt(r.employeeFirstName)}</td>
        <td>${Utils.fmt(r.employeeIdentificationCode)}</td>
        <td>${Utils.fmt(r.employeeIdentificationNumber)}</td>
        <td><strong>${Utils.fmt(r.employeeSurname)}</strong></td>
        <td>${r.archivedEmployee ? 'Oui' : 'Non'}</td>
        <td class="td-error">${Utils.fmt(r.errorMessage)}</td>
        <td class="td-mono td-muted">${Utils.fmt(r.technicalString)}</td>
        <td class="td-muted">${Utils.fmtDate(r.importedAt)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function _tableOrganization(rows) {
    return `<table>
      <thead><tr>
        <th>companyDescription</th><th>companyFaxNumber</th><th>companyFileNumber</th><th>companyKey</th>
        <th>companyMailAddress</th><th>companyPhoneNumber</th><th>companyWebAddress</th>
        <th>departmentAbbreviation</th><th>departmentDescription</th><th>departmentKey</th><th>departmentManager</th>
        <th>errorMessage</th>
        <th>firmAbbreviation</th><th>firmDescription</th><th>firmKey</th><th>firmManager</th>
        <th>fullAbbreviation</th><th>fullDescription</th>
        <th>level4Abbreviation</th><th>level4Description</th><th>level4Key</th><th>level4Manager</th>
        <th>level5Abbreviation</th><th>level5Description</th><th>level5Key</th><th>level5Manager</th>
        <th>level6Abbreviation</th><th>level6Description</th><th>level6Key</th><th>level6Manager</th>
        <th>level7Abbreviation</th><th>level7Description</th><th>level7Key</th><th>level7Manager</th>
        <th>level8Abbreviation</th><th>level8Description</th><th>level8Key</th><th>level8Manager</th>
        <th>levels</th><th>levelType</th><th>manager</th>
        <th>organizationChartLevelAbbreviation</th><th>organizationChartLevelDescription</th><th>organizationChartLevelDescriptionType</th><th>organizationChartLevelKey</th>
        <th>sectionAbbreviation</th><th>sectionDescription</th><th>sectionKey</th><th>sectionManager</th>
        <th>subDepartmentAbbreviation</th><th>subDepartmentDescription</th><th>subDepartmentKey</th><th>subDepartmentManager</th>
        <th>technicalString</th><th>imported_at</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${Utils.fmt(r.company_description)}</td>
        <td>${Utils.fmt(r.company_fax_number)}</td>
        <td>${Utils.fmt(r.company_file_number)}</td>
        <td class="td-mono">${Utils.fmt(r.company_key)}</td>
        <td>${Utils.fmt(r.company_mail_address)}</td>
        <td>${Utils.fmt(r.company_phone_number)}</td>
        <td>${Utils.fmt(r.company_web_address)}</td>
        <td>${Utils.fmt(r.department_abbreviation)}</td>
        <td>${Utils.fmt(r.department_description)}</td>
        <td class="td-mono">${Utils.fmt(r.department_key)}</td>
        <td>${Utils.fmt(r.department_manager)}</td>
        <td class="td-error">${Utils.fmt(r.error_message)}</td>
        <td>${Utils.fmt(r.firm_abbreviation)}</td>
        <td>${Utils.fmt(r.firm_description)}</td>
        <td class="td-mono">${Utils.fmt(r.firm_key)}</td>
        <td>${Utils.fmt(r.firm_manager)}</td>
        <td>${Utils.fmt(r.full_abbreviation)}</td>
        <td>${Utils.fmt(r.full_description)}</td>
        <td>${Utils.fmt(r.level4_abbreviation)}</td>
        <td>${Utils.fmt(r.level4_description)}</td>
        <td class="td-mono">${Utils.fmt(r.level4_key)}</td>
        <td>${Utils.fmt(r.level4_manager)}</td>
        <td>${Utils.fmt(r.level5_abbreviation)}</td>
        <td>${Utils.fmt(r.level5_description)}</td>
        <td class="td-mono">${Utils.fmt(r.level5_key)}</td>
        <td>${Utils.fmt(r.level5_manager)}</td>
        <td>${Utils.fmt(r.level6_abbreviation)}</td>
        <td>${Utils.fmt(r.level6_description)}</td>
        <td class="td-mono">${Utils.fmt(r.level6_key)}</td>
        <td>${Utils.fmt(r.level6_manager)}</td>
        <td>${Utils.fmt(r.level7_abbreviation)}</td>
        <td>${Utils.fmt(r.level7_description)}</td>
        <td class="td-mono">${Utils.fmt(r.level7_key)}</td>
        <td>${Utils.fmt(r.level7_manager)}</td>
        <td>${Utils.fmt(r.level8_abbreviation)}</td>
        <td>${Utils.fmt(r.level8_description)}</td>
        <td class="td-mono">${Utils.fmt(r.level8_key)}</td>
        <td>${Utils.fmt(r.level8_manager)}</td>
        <td class="td-muted">${Utils.fmt(r.levels)}</td>
        <td class="td-muted">${Utils.fmt(r.level_type)}</td>
        <td>${Utils.fmt(r.manager)}</td>
        <td>${Utils.fmt(r.organization_chart_level_abbreviation)}</td>
        <td><strong>${Utils.fmt(r.organization_chart_level_description)}</strong></td>
        <td class="td-muted">${Utils.fmt(r.organization_chart_level_description_type)}</td>
        <td class="td-mono">${Utils.fmt(r.organization_chart_level_key)}</td>
        <td>${Utils.fmt(r.section_abbreviation)}</td>
        <td>${Utils.fmt(r.section_description)}</td>
        <td class="td-mono">${Utils.fmt(r.section_key)}</td>
        <td>${Utils.fmt(r.section_manager)}</td>
        <td>${Utils.fmt(r.sub_department_abbreviation)}</td>
        <td>${Utils.fmt(r.sub_department_description)}</td>
        <td class="td-mono">${Utils.fmt(r.sub_department_key)}</td>
        <td>${Utils.fmt(r.sub_department_manager)}</td>
        <td class="td-mono td-muted">${Utils.fmt(r.technical_string)}</td>
        <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function _tableSectionAssignments(rows) {
    return `<table>
      <thead><tr>
        <th>Salarié</th><th>Clé section</th><th>Code</th><th>Libellé</th>
        <th>Date affectation</th><th>Importé le</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${Utils.fmt(r.employee_label)}</td>
        <td class="td-mono">${Utils.fmt(r.section_key)}</td>
        <td>${Utils.fmt(r.section_code)}</td>
        <td>${Utils.fmt(r.section_description)}</td>
        <td>${Utils.fmtDate(r.assignment_date)}</td>
        <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function _dirBadge(dir) {
    if (!dir) return '<span class="td-muted">—</span>';
    const map = { '1': ['Entrée',  'var(--color-success)'], '2': ['Sortie', 'var(--color-danger)'],
                  'IN': ['Entrée', 'var(--color-success)'], 'OUT': ['Sortie','var(--color-danger)'] };
    const [label, color] = map[String(dir)] ?? [String(dir), 'var(--color-muted)'];
    return `<span style="font-weight:600;color:${color};">${Utils.esc(label)}</span>`;
  }

  async function _export() {
    try {
      const res = await window.KelioAPI.exportCsv({ type: _activeTab, filters: _filters });
      if (res.ok) Toast.success('Export CSV enregistré.');
      else if (res.reason !== 'annulé') Toast.error(`Export échoué: ${res.reason}`);
    } catch (e) {
      Toast.error(`Erreur export: ${e.message}`);
    }
  }

  /**
   * Affiche une modal d'aide expliquant les données de l'onglet actif
   */
  function _showHelp() {
    const currentTab = TABS.find(t => t.key === _activeTab);
    if (!currentTab) return;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="max-width:500px;">
        <div class="modal-header">
          <h3>${currentTab.icon} ${currentTab.label} - Aide</h3>
          <button class="modal-close" id="modalClose">×</button>
        </div>
        <div class="modal-body">
          <p style="line-height:1.6;">${currentTab.help}</p>
          <div style="margin-top:16px;padding:12px;background:var(--color-bg-subtle);border-radius:6px;font-size:13px;">
            <strong>💡 Conseil :</strong> Utilisez les filtres ci-dessus pour restreindre les données à une période ou un salarié spécifique. Exportez en CSV pour analyser les données dans Excel.
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="modalOk">Compris</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('modalClose').addEventListener('click', () => modal.remove());
    document.getElementById('modalOk').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  /**
   * Change l'onglet actif programmatiquement (utilisé par app.js pour la redirection legacy)
   * @param {string} tabKey - Clé de l'onglet à activer (ex: 'employees')
   */
  function setActiveTab(tabKey) {
    if (TABS.some(t => t.key === tabKey)) {
      _activeTab = tabKey;
      _page = 1;
      _filters = {};
    }
  }

  return { render, setActiveTab };
})();
