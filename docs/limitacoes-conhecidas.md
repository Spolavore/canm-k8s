# Limitações Conhecidas

Este documento lista restrições, dependências externas e pré-requisitos de
ambiente do CANM que não estão capturadas nas dependências do `package.json`
e que impactam diretamente o funcionamento da aplicação em runtime.

## Dependências de CLIs externas

O CANM faz `execSync` em comandos `gcloud` e `kubectl`. Essas ferramentas
**precisam estar presentes no PATH** do processo em runtime e devidamente
autenticadas para o cluster/projeto alvo. Quando o CANM for empacotado em
uma imagem Docker, ambos os binários precisam ser instalados na imagem.

### `kubectl` ≥ 1.31

A função `KubernetesClient.waitUntilNodeReady` utiliza
`kubectl wait --for=create`, introduzido oficialmente no **kubectl 1.31**.
Versões anteriores não reconhecem o predicado `--for=create` e falharão
com erro de flag inválida.

- **Onde é usada**: `addMigInstance` chama `waitUntilNodeReady` após o
  `gcloud compute instance-groups managed wait-until --stable`, para
  garantir que o Node foi registrado pelo `kubelet` e está `Ready` antes
  de a saga avançar para o `drain`.
- **Impacto se não atendido**: a etapa `addNode<Pool>` da migração falhará
  imediatamente após o nó ser criado no MIG, deixando uma instância
  órfã no pool de destino (a ser limpa pela reconciliação descrita em
  [compensacao-e-reconciliacao.md](compensacao-e-reconciliacao.md)).
- **Como verificar a versão**: `kubectl version --client --output=yaml`.

### `gcloud` com suporte a `wait-until --stable`

O CANM usa `gcloud compute instance-groups managed wait-until --stable`
em `addMigInstance` e `removeMigInstance`. O formato anterior
`wait-until-stable` (sem o subcomando `wait-until`) foi deprecado. Em
versões muito antigas do `gcloud` o subcomando `wait-until` pode não
existir.

- **Recomendação**: gcloud SDK em versão razoavelmente recente
  (≥ 400.0.0 funciona com folga).
- **Como verificar**: `gcloud version`.

## Topologia do cluster

### Suporte a clusters zonais

Atualmente o CANM passa `getRegion()` (vindo de `GKE_REGION`) diretamente
para o flag `--zone` do `gcloud` em `addMigInstance`
([GkeNodeMigrator.ts:133](../src/components/GkeNodeMigrator.ts#L133)).
Isso funciona apenas quando a variável de ambiente `GKE_REGION` está
configurada com **uma zona** (ex.: `us-central1-a`), não com uma região
(`us-central1`).

- **Cenário suportado**: cluster zonal (um único MIG em uma zona).
- **Cenário não suportado**: cluster regional (MIGs distribuídos em
  múltiplas zonas). Neste caso, seria necessário escolher
  programaticamente uma zona ao criar a instância — ainda não
  implementado.
- **`removeNode` é mais robusto**: extrai a zona da própria instância
  alvo antes de chamar `delete-instances`
  ([GkeNodeMigrator.ts:87-89](../src/components/GkeNodeMigrator.ts#L87-L89)),
  então a remoção funciona em regional. A assimetria está na adição.

## Concorrência

### Single-writer assumption

O CANM assume que é o **único processo** mexendo nos node pools que ele
gerencia. Não há locking distribuído nem `lease` do Kubernetes para
coordenar múltiplas réplicas. Se mais de uma instância do CANM rodar
contra o mesmo cluster, haverá:

- corridas em `getNodePoolCount`/listagem de MIG → decisões baseadas em
  estado inconsistente;
- possibilidade de duas migrações simultâneas para o mesmo nó;
- duplicidade de annotations (após implementação de M3).

**Mitigação atual**: rodar apenas uma réplica do CANM por cluster.

## Estado e persistência

### Sem persistência entre reinícios (até M3)

Até a implementação da Milestone M3 descrita em
[`../ignore/milestones-compensacao.md`](../ignore/milestones-compensacao.md),
o CANM não persiste o estado de migrações em andamento. Um restart no
meio de uma saga `add → drain → remove` pode deixar o cluster em estado
inconsistente sem qualquer marcação para reconciliação posterior.

A partir de M3, esse estado vive como annotations no recurso `Node` e
sobrevive a reinícios.

## Autenticação

### Credenciais GKE via variáveis de ambiente

Esperado em runtime:
- `EXTERNAL_PROVIDER=gke`
- `GKE_CLUSTER_NAME`, `GKE_REGION`, `GKE_PROJECT`
- Credenciais do gcloud já configuradas (via `gkeCredentialsGenerator`,
  conforme [KubernetesClient.ts:15-29](../src/lib/KubernetesClient.ts#L15-L29)).

Sem essas variáveis o CANM cai no fallback "tenta usar `~/.kube/config`",
o que normalmente não é o desejado em ambiente containerizado.
