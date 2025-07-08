function toggleAccordion(event) {
  const button = event.currentTarget;
  const expanded = button.getAttribute('aria-expanded') === 'true';
  const controlsId = button.getAttribute('aria-controls');
  const panel = document.getElementById(controlsId);

  document.querySelectorAll('#suppliersAccordion [role="region"]').forEach(el => {
    el.classList.add('hidden');
  });

  document.querySelectorAll('#suppliersAccordion button').forEach(btn => {
    btn.setAttribute('aria-expanded', 'false');
    btn.querySelector('svg')?.classList.remove('rotate-180');
  });

  if (!expanded) {
    panel.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    button.querySelector('svg')?.classList.add('rotate-180');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#suppliersAccordion .accordion-toggle')
    .forEach(button => button.addEventListener('click', toggleAccordion));

  document.querySelectorAll('#suppliersAccordion button[aria-expanded="true"]')
    .forEach(btn => {
      btn.querySelector('svg')?.classList.add('rotate-180');
    });
});
