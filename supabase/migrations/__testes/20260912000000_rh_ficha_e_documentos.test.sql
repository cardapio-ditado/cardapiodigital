\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Cenário: duas casas da mesma rede, e a mesma pessoa trabalhando nas duas.
insert into venues (id, name) values
  ('11111111-1111-1111-1111-111111111111','Ditado Popular'),
  ('11111111-1111-1111-1111-111111111112','Ditado Sorriso');

insert into pesquisa_atendentes (id, venue_id, nome) values
  ('22222222-2222-2222-2222-222222222221','11111111-1111-1111-1111-111111111111','Ana Paula'),
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','Carlos'),
  ('22222222-2222-2222-2222-222222222223','11111111-1111-1111-1111-111111111112','Ana Paula');

insert into rh_fichas (venue_id, atendente_id, nome_completo, cpf, vinculo, admissao)
values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221',
        'Ana Paula de Souza','52998224725','clt','2026-01-10');

\echo '--- 1. UMA FICHA POR PESSOA ---'
do $$
begin
  insert into rh_fichas (venue_id, atendente_id, nome_completo)
  values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221','Ana P. Souza');
  raise exception 'FALHA: abriu duas fichas para a mesma pessoa';
exception when unique_violation then
  raise notice 'ok   segunda ficha barrada — duas telas abertas não viram duas fichas';
end $$;

\echo '--- 2. CPF REPETIDO NA MESMA CASA ---'
do $$
begin
  insert into rh_fichas (venue_id, atendente_id, cpf)
  values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','52998224725');
  raise exception 'FALHA: aceitou o mesmo CPF duas vezes na mesma casa';
exception when unique_violation then
  raise notice 'ok   CPF repetido barrado — é erro de digitação ou pessoa duplicada';
end $$;

\echo '--- 3. O MESMO CPF EM OUTRA CASA DA REDE ---'
insert into rh_fichas (venue_id, atendente_id, cpf, vinculo)
values ('11111111-1111-1111-1111-111111111112','22222222-2222-2222-2222-222222222223','52998224725','diarista');
select case when count(*) = 2 then 'ok   mesma pessoa em duas casas — duas fichas legítimas'
            else 'FALHA: a segunda casa não conseguiu abrir ficha' end
from rh_fichas where cpf = '52998224725';

\echo '--- 4. FICHA SEM CPF NÃO COLIDE COM OUTRA SEM CPF ---'
insert into pesquisa_atendentes (id, venue_id, nome) values
  ('22222222-2222-2222-2222-222222222224','11111111-1111-1111-1111-111111111111','Joana'),
  ('22222222-2222-2222-2222-222222222225','11111111-1111-1111-1111-111111111111','Marcos');
insert into rh_fichas (venue_id, atendente_id) values
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222224'),
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222225');
select case when count(*) = 2 then 'ok   duas fichas sem CPF convivem — o índice único ignora o vazio'
            else 'FALHA: ficha sem CPF colidiu' end
from rh_fichas where cpf is null and venue_id = '11111111-1111-1111-1111-111111111111';

\echo '--- 5. VÍNCULO INVENTADO ---'
do $$
begin
  insert into rh_fichas (venue_id, atendente_id, vinculo)
  values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','estagiario');
  raise exception 'FALHA: aceitou vínculo fora da lista';
exception when check_violation then
  raise notice 'ok   vínculo "estagiario" recusado — a lista é fechada de propósito';
end $$;

\echo '--- 6. TIPO DE DOCUMENTO INVENTADO ---'
do $$
begin
  insert into rh_documentos (venue_id, atendente_id, tipo, caminho)
  values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222221',
          'certidao_de_casamento','x/y.pdf');
  raise exception 'FALHA: aceitou tipo de documento fora da lista';
exception when check_violation then
  raise notice 'ok   tipo fora da lista recusado';
end $$;

\echo '--- 7. O CARIMBO DE ATUALIZAÇÃO SE MEXE SOZINHO ---'
update rh_fichas set atualizada_em = '2020-01-01'
 where atendente_id = '22222222-2222-2222-2222-222222222221';
update rh_fichas set cargo = 'Garçonete'
 where atendente_id = '22222222-2222-2222-2222-222222222221';
select case when atualizada_em > now() - interval '1 minute'
            then 'ok   atualizada_em subiu sozinha no update'
            else 'FALHA: atualizada_em ficou parada em ' || atualizada_em end
from rh_fichas where atendente_id = '22222222-2222-2222-2222-222222222221';

\echo '--- 8. TIRAR A PESSOA DO CADASTRO LEVA FICHA E DOCUMENTO JUNTO ---'
insert into rh_documentos (venue_id, atendente_id, tipo, caminho, validade)
values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222224',
        'exame_admissional','casa/pessoa/exame.pdf','2026-10-01');
delete from pesquisa_atendentes where id = '22222222-2222-2222-2222-222222222224';
select case when (select count(*) from rh_fichas where atendente_id = '22222222-2222-2222-2222-222222222224') = 0
             and (select count(*) from rh_documentos where atendente_id = '22222222-2222-2222-2222-222222222224') = 0
            then 'ok   ficha e documentos saíram junto — nada de CPF órfão no banco'
            else 'FALHA: sobrou ficha ou documento sem dono' end;

\echo '--- 9. O BALDE DO RH É PRIVADO ---'
select case when public = false and file_size_limit = 20971520
            then 'ok   balde "rh" privado, teto de 20 MB'
            else 'FALHA: balde do RH está público ou com teto errado' end
from storage.buckets where id = 'rh';

select case when count(*) = 0
            then 'ok   nenhuma policy de leitura pública no balde do RH'
            else 'FALHA: existe policy abrindo o balde do RH' end
from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'rh e publico para leitura';

\echo '--- 10. RODAR A MIGRAÇÃO DUAS VEZES NÃO QUEBRA NADA ---'
\i supabase/migrations/20260912000000_rh_ficha_e_documentos.sql
-- Três: Ana na casa 1, Ana na casa 2 e Marcos. Joana saiu no teste 8, junto
-- com a pessoa dela no cadastro.
select case when count(*) = 3 then 'ok   migração idempotente — as fichas continuam lá'
            else 'FALHA: rodar de novo mexeu nos dados (' || count(*) || ' fichas)' end
from rh_fichas;
