script de validacao para ver se todas as informacoes estao okay antes de prosseguir:
* O cluster informado existe
* Os node pool existem no cluster informado

* Normalizar score
resource leak em migrateNode (MigratorOrchestrator.ts):
* se addNode() succeeds mas drain() falha, o novo nó foi adicionado e nunca é removido
* solução: ao detectar falha parcial, fazer rollback removendo o nó recém adicionado
* Demora na atualizacao do nodepool, validar



Acoes:
removendo metrica de rede-> nao houve ganhos significativos
 "para workloads stateless de processamento, I/O e rede demonstraram ser sinais com baixo poder discriminativo nos experimentos preliminares; o score baseia-se nas duas dimensões de pressão de recurso mais relevantes para essa classe de aplicações."