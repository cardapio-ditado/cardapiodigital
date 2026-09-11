-- RH — a gorjeta em PORCENTAGEM, e quanto disso chega no bolso.
--
-- O primeiro desenho só aceitava um valor fechado ("entraram R$ 900 de
-- serviço"). Não é assim que a casa pensa nem que a equipe cobra: o serviço é
-- um PERCENTUAL sobre a venda, e nem tudo que entra é repassado — parte fica
-- com a casa para cobrir taxa de cartão, quebra e o que a casa combinar.
--
-- Agora o lançamento guarda a conta inteira, e não só o resultado:
--   base de venda  ×  % de serviço   =  arrecadado
--   arrecadado     ×  % de repasse   =  repassado (o que é dividido)
--
-- E a base pode ser de duas naturezas:
--   GLOBAL      — a venda do turno inteiro, um número só.
--   INDIVIDUAL  — a venda de cada um, e aí a divisão é por venda própria.
--                 É como funciona a comissão de garçom em muita casa.
--
-- Guardar a conta, e não só o total, é o que permite responder "por que eu
-- recebi isso?" seis meses depois — que é a pergunta que gera discussão.

alter table public.rh_gorjetas add column if not exists base_venda numeric(12, 2);
alter table public.rh_gorjetas add column if not exists percentual_servico numeric(5, 2);
alter table public.rh_gorjetas add column if not exists percentual_repasse numeric(5, 2) not null default 100;
alter table public.rh_gorjetas add column if not exists valor_repassado numeric(12, 2);

comment on column public.rh_gorjetas.valor is
  'O total arrecadado de serviço no turno. Com percentual, é base_venda × percentual_servico.';
comment on column public.rh_gorjetas.valor_repassado is
  'O que foi efetivamente dividido entre a equipe: valor × percentual_repasse. A diferença fica com a casa.';

-- Percentual fora de 0–100 é sempre erro de digitação (12 virando 1200).
do $$
begin
  alter table public.rh_gorjetas add constraint rh_gorjetas_percentuais
    check (
      (percentual_servico is null or (percentual_servico >= 0 and percentual_servico <= 100))
      and percentual_repasse >= 0 and percentual_repasse <= 100
    );
exception when duplicate_object then null;
end $$;

-- A venda individual de cada um, quando a divisão é por venda própria.
alter table public.rh_gorjeta_cotas add column if not exists venda numeric(12, 2) not null default 0;

-- Critério novo: por venda individual. O check antigo é substituído.
alter table public.rh_gorjetas drop constraint if exists rh_gorjetas_criterio_check;
do $$
begin
  alter table public.rh_gorjetas add constraint rh_gorjetas_criterio_check
    check (criterio in ('igual', 'peso', 'horas', 'venda'));
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
